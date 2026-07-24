import AppKit

final class MainViewController: NSViewController {
    private var logView: NSTextView!
    private let workspacePopup = NSPopUpButton()
    private let queryField = NSTextField()
    private let runButton = NSButton(title: "运行", target: nil, action: nil)
    private let cancelButton = NSButton(title: "取消 Run", target: nil, action: nil)
    private let attachChip = NSButton(title: "", target: nil, action: nil)
    private let spinner = NSProgressIndicator()

    private var workspaces: [Workspace] = []
    private var newTask: StreamTask?
    // One live event stream: either the workspace-wide multiplexer or a single
    // run's normalized native trajectory (orch events tail --native).
    private var streamTask: StreamTask?
    private var currentStreamRunID: String?
    private var detailTailer: FileTailer?
    private var selectedRun: RunEntry?
    // Input-box target: nil = `orch new`; otherwise messages continue this
    // run's provider session via `orch run create --resume-from`.
    private var attachTarget: RunEntry?

    private static let activeStates: Set<String> = ["running", "starting", "pending"]

    var onRunsChanged: (() -> Void)?

    var currentWorkspace: Workspace? {
        let idx = workspacePopup.indexOfSelectedItem
        guard idx >= 0, idx < workspaces.count else { return nil }
        return workspaces[idx]
    }

    override func loadView() {
        let scroll = NSTextView.scrollableTextView()
        logView = (scroll.documentView as! NSTextView)
        logView.isEditable = false
        logView.isRichText = false
        logView.drawsBackground = true
        logView.backgroundColor = .textBackgroundColor
        logView.textContainerInset = NSSize(width: 6, height: 8)

        workspacePopup.target = self
        workspacePopup.action = #selector(workspaceChanged)
        workspacePopup.setContentHuggingPriority(.required, for: .horizontal)

        queryField.placeholderString = "描述一个新任务，回车执行 orch new …"
        queryField.target = self
        queryField.action = #selector(submit)
        queryField.setContentHuggingPriority(.defaultLow, for: .horizontal)

        runButton.target = self
        runButton.action = #selector(submit)
        runButton.bezelStyle = .rounded

        cancelButton.target = self
        cancelButton.action = #selector(cancelSelectedRun)
        cancelButton.bezelStyle = .rounded
        cancelButton.isEnabled = false

        attachChip.target = self
        attachChip.action = #selector(detach)
        attachChip.bezelStyle = .rounded
        attachChip.isHidden = true
        attachChip.setContentHuggingPriority(.required, for: .horizontal)
        attachChip.toolTip = "点击脱离，恢复 orch new"

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        let bar = NSStackView(views: [workspacePopup, attachChip, queryField, runButton, cancelButton, spinner])
        bar.orientation = .horizontal
        bar.spacing = 8

        let root = NSStackView(views: [scroll, bar])
        root.orientation = .vertical
        root.spacing = 8
        root.edgeInsets = NSEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        root.setFrameSize(NSSize(width: 800, height: 640))
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        loadWorkspaces()
    }

    // MARK: workspaces

    private func loadWorkspaces() {
        struct WorkspaceList: Decodable { let workspaces: [Workspace] }
        Orch.capture(["workspace", "list"]) { [weak self] data, err in
            guard let self else { return }
            if let err {
                self.appendLog("⚠️ \(err)\n", color: .systemRed)
                return
            }
            guard let data,
                  let list = try? JSONDecoder().decode(WorkspaceList.self, from: data) else {
                self.appendLog("⚠️ 解析 workspace list 失败\n", color: .systemRed)
                return
            }
            self.workspaces = list.workspaces
            self.workspacePopup.removeAllItems()
            for ws in list.workspaces {
                self.workspacePopup.addItem(withTitle: ws.id)
                self.workspacePopup.lastItem?.toolTip = ws.path
            }
            let saved = UserDefaults.standard.string(forKey: "workspace")
            if let saved, let idx = list.workspaces.firstIndex(where: { $0.id == saved }) {
                self.workspacePopup.selectItem(at: idx)
            }
            if list.workspaces.isEmpty {
                self.appendLog("尚未注册 workspace：先运行 `orch workspace add --id <id> --path <dir>`\n",
                               color: .secondaryLabelColor)
            }
            self.workspaceChanged()
        }
    }

    @objc private func workspaceChanged() {
        guard let ws = currentWorkspace else { return }
        UserDefaults.standard.set(ws.id, forKey: "workspace")
        // The workspace only scopes `orch new`; the sidebar and the global
        // stream cover every repo under the orch state root.
        if streamTask == nil { startGlobalStream() }
    }

    // MARK: event streams

    private func startGlobalStream() {
        currentStreamRunID = nil
        detailTailer?.stop()
        detailTailer = nil
        streamTask?.terminate()
        appendLog("\n── 全局进展流 · 全部仓库 ──\n", color: .tertiaryLabelColor)
        streamTask = StreamTask(["events", "tail", "-f", "--all", "--native"],
                                cwd: NSHomeDirectory()) { [weak self] text in
            self?.appendCapped(text, color: .secondaryLabelColor)
        }
    }

    /// Sidebar selection drives what renders: a run row shows that agent's
    /// trajectory summarized straight from its state-dir native.jsonl (live
    /// runs keep following by file offset); anything else returns to the
    /// all-repo multiplexer. Reselecting the same run only refreshes state so
    /// the sidebar's 5s poll does not re-render the view.
    func selectRun(_ entry: RunEntry?) {
        selectedRun = entry
        updateCancelButton()
        guard let entry else {
            if currentStreamRunID != nil { startGlobalStream() }
            return
        }
        if entry.info.run_id == currentStreamRunID {
            // Fresh state from the sidebar poll: stop following once terminal.
            if detailTailer != nil, !Self.activeStates.contains(entry.info.state) {
                detailTailer?.stop()
                detailTailer = nil
                appendLog("── run 已终态 (\(entry.info.state)) ──\n", color: .tertiaryLabelColor)
            }
            return
        }
        showRunDetail(entry)
    }

    private static let detailEventCount = 12

    // The trajectory renders from the persisted native.jsonl, one summarized
    // line per event: parsing the JSON resolves the escaped-blob soup a raw
    // dump (or the CLI's rendering of huge final messages) produces, and the
    // state dir needs no worktree — deleted scratch dirs replay identically.
    private func showRunDetail(_ entry: RunEntry) {
        let info = entry.info
        currentStreamRunID = info.run_id
        detailTailer?.stop()
        detailTailer = nil
        streamTask?.terminate()
        streamTask = nil
        appendLog("\n── \(info.role) · \(info.agent) · \(info.state) — \(info.run_id) ──\n",
                  color: .tertiaryLabelColor)

        let nativePath = entry.runDir + "/native.jsonl"
        let eventsPath = entry.runDir + "/events.jsonl"
        let nativeSize = (try? FileManager.default.attributesOfItem(atPath: nativePath))?[.size] as? Int ?? 0
        // Active runs always follow native.jsonl — it may not exist yet for a
        // just-created run and the tailer waits for it. Terminal runs with an
        // empty native.jsonl (some providers) fall back to the orch event log.
        let active = Self.activeStates.contains(info.state)
        let path = active || nativeSize > 0 ? nativePath : eventsPath
        // Read a generous window, then keep only events with human-relevant
        // text: token-progress events dominate the raw stream (observed
        // ~2/3 of a claude run) and would fill the view with blank rows.
        let tail = NativeLog.tail(path: path, count: 300) ?? NativeTail(lines: [], endOffset: 0)
        var summaries = tail.lines.map(NativeLog.summarize).filter { !$0.text.isEmpty }
        if summaries.isEmpty {
            summaries = tail.lines.suffix(5).map { ("raw", NativeLog.clip($0, 300)) }
        }
        let shown = summaries.suffix(Self.detailEventCount)
        if shown.isEmpty {
            appendLog(active ? "(等待事件…)\n" : "(无事件记录)\n", color: .secondaryLabelColor)
        } else {
            appendLog("最近 \(shown.count) 条事件：\n", color: .tertiaryLabelColor)
            for summary in shown { appendSummary(summary) }
        }

        if active {
            detailTailer = FileTailer(path: path, offset: tail.endOffset) { [weak self] line in
                self?.appendEvent(line)
            }
        }
    }

    private func appendEvent(_ line: String) {
        let summary = NativeLog.summarize(line)
        guard !summary.text.isEmpty else { return }
        appendSummary(summary)
    }

    private func appendSummary(_ summary: (tag: String, text: String)) {
        appendLog("▸ \(summary.tag)  ", color: summary.tag.contains("error") ? .systemRed : .tertiaryLabelColor)
        appendLog(summary.text + "\n", color: .labelColor)
    }

    // MARK: attach — the input box targets a run's provider session

    /// Attach only makes sense for a terminal run with a persisted provider
    /// session: `orch run create --resume-from` refuses anything else.
    func attachRun(_ entry: RunEntry) {
        let info = entry.info
        if Self.activeStates.contains(info.state) {
            showError("run 仍在执行，待终态后再 attach")
            return
        }
        if info.provider_session_mode == "ephemeral" || (info.provider_resume_id ?? info.provider_session_id) == nil {
            showError("该 run 未保留 provider session，无法 attach")
            return
        }
        attachTarget = entry
        attachChip.title = "@ \(info.agent)·\(info.role) ✕"
        attachChip.isHidden = false
        queryField.placeholderString = "发消息给 \(info.agent)（续接 \(info.run_id)）"
        if info.run_id != currentStreamRunID { showRunDetail(entry) }
        appendLog("── 已 attach：输入将经 orch run create --resume-from 发给该 session ──\n",
                  color: .tertiaryLabelColor)
        view.window?.makeFirstResponder(queryField)
    }

    @objc private func detach() {
        attachTarget = nil
        attachChip.isHidden = true
        queryField.placeholderString = "描述一个新任务，回车执行 orch new …"
    }

    private func sendToAttached(_ text: String, target: RunEntry) {
        let info = target.info
        var isDir: ObjCBool = false
        let wtExists = info.worktree.map { FileManager.default.fileExists(atPath: $0, isDirectory: &isDir) && isDir.boolValue } ?? false
        guard let worktree = wtExists ? info.worktree : currentWorkspace?.path else {
            showError("run 的 worktree 已删除且无可用 workspace")
            return
        }
        let taskPath = NSTemporaryDirectory() + "orch-gui-attach-\(UUID().uuidString).md"
        do { try text.write(toFile: taskPath, atomically: true, encoding: .utf8) } catch {
            showError("写入消息文件失败: \(error.localizedDescription)")
            return
        }
        appendLog("\n$ [\(info.agent)·\(info.role)] \(text)\n", color: .systemBlue)
        queryField.isEnabled = false
        spinner.startAnimation(nil)
        // Same tag keeps the session-chain guard's tag family; the chain
        // itself is a deliberate, user-driven continuation.
        Orch.capture(["run", "create",
                      "--resume-from", info.run_id,
                      "--mr", info.mr,
                      "--worktree", worktree,
                      "--tag", info.tag ?? info.role,
                      "--allow-session-chain",
                      "--task", taskPath,
                      "--json"]) { [weak self] data, err in
            guard let self else { return }
            try? FileManager.default.removeItem(atPath: taskPath)
            self.spinner.stopAnimation(nil)
            self.queryField.isEnabled = true
            if let err {
                self.showError(err)
                return
            }
            struct CreatePayload: Decodable { let run_id: String; let status_path: String }
            guard let data, let payload = try? JSONDecoder().decode(CreatePayload.self, from: data) else {
                self.showError("解析 run create 输出失败")
                return
            }
            self.queryField.stringValue = ""
            let runDir = (payload.status_path as NSString).deletingLastPathComponent
            if let statusData = FileManager.default.contents(atPath: payload.status_path),
               let newInfo = try? JSONDecoder().decode(RunInfo.self, from: statusData) {
                let entry = RunEntry(info: newInfo, runDir: runDir, decision: nil)
                // Follow the reply live and roll the attach target forward so
                // the next message continues from the newest run in the chain.
                self.attachTarget = entry
                self.showRunDetail(entry)
            }
            self.onRunsChanged?()
            self.view.window?.makeFirstResponder(self.queryField)
        }
    }

    // MARK: run / cancel

    @objc private func submit() {
        if let task = newTask, task.isRunning {
            appendLog("\n⏹ 中断 orch new …\n", color: .systemOrange)
            task.interrupt()
            return
        }
        let query = queryField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        if let target = attachTarget {
            sendToAttached(query, target: target)
            return
        }
        guard let ws = currentWorkspace else {
            appendLog("⚠️ 请先选择 workspace\n", color: .systemRed)
            return
        }

        appendLog("\n$ orch new '\(query)' --workspace \(ws.id) --yes\n", color: .systemBlue)
        setBusy(true)
        // The global multiplexer picks up runs created while following; make
        // sure it is the active stream so the new controller's workers show.
        if currentStreamRunID != nil { startGlobalStream() }

        newTask = StreamTask(["new", query, "--workspace", ws.id, "--yes"],
                             cwd: ws.path) { [weak self] text in
            self?.appendLog(text)
        } onExit: { [weak self] code in
            guard let self else { return }
            self.appendLog("\n— orch new 结束，退出码 \(code)\n",
                           color: code == 0 ? .systemGreen : .systemRed)
            self.setBusy(false)
            self.newTask = nil
            self.onRunsChanged?()
        }

        if newTask == nil {
            setBusy(false)
            return
        }
        queryField.stringValue = ""
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.onRunsChanged?() }
    }

    @objc private func cancelSelectedRun() {
        guard let entry = selectedRun else { return }
        let run = entry.info
        guard let worktree = run.worktree ?? currentWorkspace?.path else { return }
        appendLog("\n$ orch run cancel --run \(run.run_id)\n", color: .systemOrange)
        cancelButton.isEnabled = false
        Orch.capture(["run", "cancel", "--run", run.run_id, "--mr", run.mr,
                      "--reason", "canceled from gui", "--worktree", worktree]) { [weak self] data, err in
            if let err {
                self?.appendLog("⚠️ \(err)\n", color: .systemRed)
            } else if let data, let text = String(data: data, encoding: .utf8), !text.isEmpty {
                self?.appendLog(text.hasSuffix("\n") ? text : text + "\n", color: .secondaryLabelColor)
            }
            self?.onRunsChanged?()
        }
    }

    private func updateCancelButton() {
        let active = ["running", "starting", "pending"].contains(selectedRun?.info.state ?? "")
        cancelButton.isEnabled = active
    }

    private func setBusy(_ busy: Bool) {
        runButton.title = busy ? "停止" : "运行"
        queryField.isEnabled = !busy
        workspacePopup.isEnabled = !busy
        if busy { spinner.startAnimation(nil) } else {
            spinner.stopAnimation(nil)
            view.window?.makeFirstResponder(queryField)
        }
    }

    // MARK: inspect

    /// result.json is read straight from the run's state dir: no CLI round
    /// trip, and it works when the run's worktree no longer exists.
    func inspectRun(_ entry: RunEntry) {
        appendLog("\n── result · \(entry.info.run_id) ──\n", color: .systemBlue)
        let path = entry.runDir + "/result.json"
        guard let data = FileManager.default.contents(atPath: path) else {
            appendLog("(尚无 result.json — run 可能仍在执行)\n", color: .secondaryLabelColor)
            return
        }
        if let obj = try? JSONSerialization.jsonObject(with: data),
           let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
           let text = String(data: pretty, encoding: .utf8) {
            appendLog(text + "\n")
        } else if let text = String(data: data, encoding: .utf8) {
            appendLog(text.hasSuffix("\n") ? text : text + "\n")
        }
    }

    func showError(_ message: String) {
        appendLog("⚠️ \(message)\n", color: .systemRed)
    }

    func stopAll() {
        newTask?.terminate()
        streamTask?.terminate()
        detailTailer?.stop()
    }

    /// Long single lines (a final event can embed a whole result JSON) make
    /// NSTextView layout crawl; cap every physical line before appending.
    private func appendCapped(_ text: String, color: NSColor, lineCap: Int = 300) {
        let capped = text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.count > lineCap ? String($0.prefix(lineCap)) + " …" : String($0) }
            .joined(separator: "\n")
        appendLog(capped, color: color)
    }

    // MARK: log

    private func appendLog(_ text: String, color: NSColor = .labelColor) {
        guard let storage = logView.textStorage else { return }
        if storage.length > 800_000 {
            storage.deleteCharacters(in: NSRange(location: 0, length: 200_000))
        }
        let atBottom = logView.visibleRect.maxY >= logView.bounds.maxY - 44
        storage.append(NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: color,
        ]))
        if atBottom { logView.scrollToEndOfDocument(nil) }
    }
}
