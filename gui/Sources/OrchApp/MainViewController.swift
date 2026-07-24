import AppKit

final class MainViewController: NSViewController {
    private var logView: NSTextView!
    private let workspacePopup = NSPopUpButton()
    private let queryField = NSTextField()
    private let runButton = NSButton(title: "运行", target: nil, action: nil)
    private let cancelButton = NSButton(title: "取消 Run", target: nil, action: nil)
    private let spinner = NSProgressIndicator()

    private var workspaces: [Workspace] = []
    private var newTask: StreamTask?
    // One live event stream: either the workspace-wide multiplexer or a single
    // run's normalized native trajectory (orch events tail --native).
    private var streamTask: StreamTask?
    private var currentStreamRunID: String?
    private var selectedRun: RunEntry?

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

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        let bar = NSStackView(views: [workspacePopup, queryField, runButton, cancelButton, spinner])
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
        streamTask?.terminate()
        appendLog("\n── 全局进展流 · 全部仓库 ──\n", color: .tertiaryLabelColor)
        streamTask = StreamTask(["events", "tail", "-f", "--all", "--native"],
                                cwd: NSHomeDirectory()) { [weak self] text in
            self?.appendLog(text, color: .secondaryLabelColor)
        }
    }

    /// Sidebar selection drives which trajectory renders: a run row streams
    /// that agent's normalized native events; anything else returns to the
    /// all-repo multiplexer. Reselecting the same run is a no-op so the
    /// sidebar's 5s poll refresh does not restart the stream.
    func selectRun(_ entry: RunEntry?) {
        selectedRun = entry
        updateCancelButton()
        guard let entry else {
            if currentStreamRunID != nil { startGlobalStream() }
            return
        }
        guard entry.info.run_id != currentStreamRunID else { return }
        var isDir: ObjCBool = false
        if let wt = entry.info.worktree,
           FileManager.default.fileExists(atPath: wt, isDirectory: &isDir), isDir.boolValue {
            startRunStream(entry, worktree: wt)
        } else {
            replayFromState(entry)
        }
    }

    private func startRunStream(_ entry: RunEntry, worktree: String) {
        let info = entry.info
        currentStreamRunID = info.run_id
        streamTask?.terminate()
        appendLog("\n── \(info.role) · \(info.agent) — \(info.run_id) ──\n", color: .tertiaryLabelColor)
        streamTask = StreamTask(
            ["events", "tail", "--run", info.run_id, "--mr", info.mr,
             "--native", "-n", "40", "-f", "--worktree", worktree],
            cwd: worktree
        ) { [weak self] text in
            self?.appendLog(text)
        } onExit: { [weak self] _ in
            // tail --run -f exits once the run is terminal and drained; only
            // fall back when this run is still the active stream.
            guard let self, self.currentStreamRunID == info.run_id else { return }
            self.appendLog("── run 已终态，返回全局流 ──\n", color: .tertiaryLabelColor)
            self.onRunsChanged?()
            self.startGlobalStream()
        }
    }

    /// The run's worktree is gone (scratch dirs get deleted) so `orch events
    /// tail` cannot derive the repo key — replay the trajectory straight from
    /// the persisted state dir instead. Such runs are terminal: a static tail
    /// is complete, not a degraded live view.
    private func replayFromState(_ entry: RunEntry) {
        currentStreamRunID = entry.info.run_id
        streamTask?.terminate()
        streamTask = nil
        appendLog("\n── \(entry.info.role) · \(entry.info.agent) — \(entry.info.run_id) (worktree 已删除，静态回放) ──\n",
                  color: .tertiaryLabelColor)
        for name in ["native.jsonl", "events.jsonl"] {
            guard let text = try? String(contentsOfFile: entry.runDir + "/" + name, encoding: .utf8) else { continue }
            let lines = text.split(separator: "\n").suffix(40)
            for line in lines {
                appendLog(String(line.prefix(400)) + (line.count > 400 ? " …\n" : "\n"), color: .secondaryLabelColor)
            }
            return
        }
        appendLog("(无事件记录)\n", color: .secondaryLabelColor)
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
