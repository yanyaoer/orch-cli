import AppKit

/// Detail-view event: display summary plus the raw jsonl line for the
/// click-to-expand HUD.
struct EventItem {
    let tag: String
    let text: String
    let raw: String
}

/// Standard macOS HUD panel (translucent dark); Esc closes it.
final class HUDPanel: NSPanel {
    override func cancelOperation(_ sender: Any?) { close() }
}

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
    private var logScroll: NSScrollView!

    // Backward paging state for the current run detail. Order safety: all
    // mutation happens on the main thread, loads are single-flight, batches
    // always insert at the fixed anchor (older batches land above newer ones
    // by construction), and async completions are dropped unless run id and
    // window offset still match.
    private struct DetailHistory {
        let runID: String
        let path: String
        var startOffset: UInt64
        var backlog: [EventItem]
        var exhausted: Bool
        var loading = false
        var notedStart = false
        var anchor: Int
    }
    private var detailHistory: DetailHistory?

    // Raw lines behind rendered events, keyed by the id embedded in the
    // line's link attribute; clicking shows the full text in a HUD.
    private var eventFullTexts: [Int: String] = [:]
    private var nextEventID = 0
    private var hudPanel: HUDPanel?
    private var hudTextView: NSTextView?

    private static let activeStates: Set<String> = ["running", "starting", "pending"]

    var onRunsChanged: (() -> Void)?

    var currentWorkspace: Workspace? {
        let idx = workspacePopup.indexOfSelectedItem
        guard idx >= 0, idx < workspaces.count else { return nil }
        return workspaces[idx]
    }

    override func loadView() {
        let scroll = NSTextView.scrollableTextView()
        logScroll = scroll
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(logScrolled),
                                               name: NSView.boundsDidChangeNotification,
                                               object: scroll.contentView)
        logView = (scroll.documentView as! NSTextView)
        logView.delegate = self
        // Event lines carry link attributes purely for click plumbing; keep
        // our colors and only signal clickability via the cursor.
        logView.linkTextAttributes = [.cursor: NSCursor.pointingHand]
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
        detailHistory = nil
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

        // Terminal runs render real history messages: the provider's own
        // session file normalized into role-based records by the trajectory
        // library. Active runs (and providers without a proven session
        // locator) keep the native.jsonl event path.
        if !Self.activeStates.contains(info.state), let session = Trajectory.sessionFile(for: info) {
            appendLog("解析 provider session（trajectory 归一化）…\n", color: .tertiaryLabelColor)
            let runID = info.run_id
            Trajectory.normalize(source: session.source, path: session.path) { [weak self] records, err in
                guard let self, self.currentStreamRunID == runID else { return }
                if let records, !records.isEmpty {
                    self.renderTrajectory(records, runID: runID)
                } else {
                    self.appendLog("（trajectory 解析失败：\(err ?? "空结果")，回退 native 事件流）\n",
                                   color: .secondaryLabelColor)
                    self.renderNativeDetail(entry)
                }
            }
            return
        }
        renderNativeDetail(entry)
    }

    private func renderTrajectory(_ records: [[String: Any]], runID: String) {
        var items: [EventItem] = []
        for record in records { items.append(contentsOf: Self.trajectoryItems(record)) }
        let shown = items.suffix(Self.detailEventCount)
        guard !shown.isEmpty else {
            appendLog("(无消息记录)\n", color: .secondaryLabelColor)
            return
        }
        appendLog("共 \(items.count) 条消息，最近 \(shown.count) 条（向上滚动加载更早，点击看全文）：\n",
                  color: .tertiaryLabelColor)
        let anchor = logView.textStorage?.length ?? 0
        for item in shown { appendAttributed(eventAttributed([item])) }
        // All records live in memory: paging reuses the backlog machinery
        // with the file window already exhausted.
        detailHistory = DetailHistory(
            runID: runID,
            path: "",
            startOffset: 0,
            backlog: Array(items.dropLast(shown.count)),
            exhausted: true,
            anchor: anchor
        )
    }

    /// One trajectory-v1 record → displayable items (an assistant record can
    /// carry both text and tool calls).
    private static func trajectoryItems(_ record: [String: Any]) -> [EventItem] {
        let role = record["role"] as? String ?? "event"
        if role == "meta" { return [] }
        let raw = (try? JSONSerialization.data(withJSONObject: record))
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
        func asText(_ value: Any?) -> String {
            if let s = value as? String { return s }
            guard let value, !(value is NSNull),
                  let data = try? JSONSerialization.data(withJSONObject: value) else { return "" }
            return String(data: data, encoding: .utf8) ?? ""
        }
        func clip(_ s: String) -> String {
            NativeLog.clip(s.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "\n", with: " ⏎ "), 400)
        }
        var items: [EventItem] = []
        let content = asText(record["content"])
        switch role {
        case "user":
            if !content.isEmpty { items.append(EventItem(tag: "user", text: clip(content), raw: raw)) }
        case "reasoning":
            if !content.isEmpty { items.append(EventItem(tag: "think", text: clip(content), raw: raw)) }
        case "assistant":
            if !content.isEmpty { items.append(EventItem(tag: "assistant", text: clip(content), raw: raw)) }
            for call in record["tool_calls"] as? [[String: Any]] ?? [] {
                let name = call["name"] as? String ?? "tool"
                let args = asText(call["args"])
                items.append(EventItem(tag: "⚙ \(name)", text: clip(args.isEmpty ? "()" : args), raw: raw))
            }
        case "tool":
            let text = content.isEmpty ? "(empty)" : content
            items.append(EventItem(tag: "↳ result", text: clip(text), raw: raw))
        default:
            if !content.isEmpty { items.append(EventItem(tag: role, text: clip(content), raw: raw)) }
        }
        return items
    }

    private func renderNativeDetail(_ entry: RunEntry) {
        let info = entry.info
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
        let tail = NativeLog.tail(path: path, count: 300) ?? NativeTail(lines: [], startOffset: 0, endOffset: 0)
        var items = tail.lines.compactMap { line -> EventItem? in
            let summary = NativeLog.summarize(line)
            return summary.text.isEmpty ? nil : EventItem(tag: summary.tag, text: summary.text, raw: line)
        }
        if items.isEmpty {
            items = tail.lines.suffix(5).map { EventItem(tag: "raw", text: NativeLog.clip($0, 300), raw: $0) }
        }
        let shown = items.suffix(Self.detailEventCount)
        if shown.isEmpty {
            appendLog(active ? "(等待事件…)\n" : "(无事件记录)\n", color: .secondaryLabelColor)
        } else {
            appendLog("最近 \(shown.count) 条事件（向上滚动加载更早，点击条目看全文）：\n", color: .tertiaryLabelColor)
        }
        let anchor = logView.textStorage?.length ?? 0
        for item in shown { appendAttributed(eventAttributed([item])) }
        detailHistory = DetailHistory(
            runID: info.run_id,
            path: path,
            startOffset: tail.startOffset,
            backlog: Array(items.dropLast(shown.count)),
            exhausted: tail.startOffset == 0,
            anchor: anchor
        )

        if active {
            detailTailer = FileTailer(path: path, offset: tail.endOffset) { [weak self] line in
                self?.appendEvent(line)
            }
        }
    }

    private func appendEvent(_ line: String) {
        let summary = NativeLog.summarize(line)
        guard !summary.text.isEmpty else { return }
        appendAttributed(eventAttributed([EventItem(tag: summary.tag, text: summary.text, raw: line)]))
    }

    // MARK: backward history paging

    private static let historyPage = 12

    @objc private func logScrolled() {
        guard detailHistory != nil else { return }
        let clip = logScroll.contentView
        let y = clip.bounds.origin.y
        // y < 0 is the elastic over-scroll at the top; the 150pt threshold
        // only applies when there is actually something to scroll.
        let scrollable = logView.frame.height > clip.bounds.height + 8
        if y < 0 || (scrollable && y < 150) { loadMoreHistory() }
    }

    private func loadMoreHistory() {
        guard var h = detailHistory, !h.loading else { return }
        guard currentStreamRunID == h.runID else {
            detailHistory = nil
            return
        }
        if h.backlog.isEmpty && h.exhausted {
            if !h.notedStart {
                h.notedStart = true
                detailHistory = h
                prependAtAnchor(eventAttributed([EventItem(tag: "history", text: "（已到最早事件）", raw: "")]))
            }
            return
        }
        if h.backlog.count >= Self.historyPage || h.exhausted {
            let take = min(Self.historyPage, h.backlog.count)
            let page = Array(h.backlog.suffix(take))
            h.backlog.removeLast(take)
            detailHistory = h
            if !page.isEmpty { prependAtAnchor(eventAttributed(page)) }
            return
        }
        // Backlog thin and file has earlier bytes: fetch the previous chunk
        // off-main, then re-enter to render. The (runID, startOffset) check
        // drops stale completions after a run switch or competing load.
        h.loading = true
        detailHistory = h
        let (path, upTo, runID) = (h.path, h.startOffset, h.runID)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let chunk = NativeLog.chunkBefore(path: path, upTo: upTo)
            let items = (chunk?.lines ?? []).compactMap { line -> EventItem? in
                let summary = NativeLog.summarize(line)
                return summary.text.isEmpty ? nil : EventItem(tag: summary.tag, text: summary.text, raw: line)
            }
            DispatchQueue.main.async {
                guard let self, var h2 = self.detailHistory, h2.runID == runID, h2.startOffset == upTo else { return }
                h2.loading = false
                if let chunk {
                    h2.startOffset = chunk.startOffset
                    h2.exhausted = chunk.startOffset == 0
                    h2.backlog.insert(contentsOf: items, at: 0)
                } else {
                    h2.exhausted = true
                }
                self.detailHistory = h2
                self.loadMoreHistory()
            }
        }
    }

    private func eventAttributed(_ items: [EventItem]) -> NSAttributedString {
        let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        let out = NSMutableAttributedString()
        for item in items {
            let tagColor: NSColor = item.tag.contains("error") ? .systemRed
                : item.tag == "user" ? .systemBlue
                : .tertiaryLabelColor
            // Reasoning and tool results read dimmer than the assistant's own
            // messages and tool calls.
            let textColor: NSColor = item.tag == "think" || item.tag.hasPrefix("↳")
                ? .secondaryLabelColor
                : .labelColor
            out.append(NSAttributedString(string: "▸ \(item.tag)  ", attributes: [
                .font: font,
                .foregroundColor: tagColor,
            ]))
            var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: textColor]
            if !item.raw.isEmpty {
                attrs[.link] = "orch-event://\(registerFullText(item.raw))"
            }
            out.append(NSAttributedString(string: item.text + "\n", attributes: attrs))
        }
        return out
    }

    private func registerFullText(_ raw: String) -> Int {
        let id = nextEventID
        nextEventID += 1
        eventFullTexts[id] = String(raw.prefix(262_144))
        // Bound memory: drop the oldest ~500 entries once past 3000; clicking
        // a pruned line reports it as cleaned up.
        if eventFullTexts.count > 3000, let oldest = eventFullTexts.keys.min() {
            for key in eventFullTexts.keys where key < oldest + 500 {
                eventFullTexts.removeValue(forKey: key)
            }
        }
        return id
    }

    /// Insert at the fixed anchor (start of the oldest displayed event) and
    /// compensate the scroll offset by the inserted height so the visible
    /// content does not jump.
    private func prependAtAnchor(_ attr: NSAttributedString) {
        guard let storage = logView.textStorage, let h = detailHistory,
              let lm = logView.layoutManager, let tc = logView.textContainer else { return }
        let clip = logScroll.contentView
        let savedY = clip.bounds.origin.y
        lm.ensureLayout(for: tc)
        let before = lm.usedRect(for: tc).height
        storage.insert(attr, at: min(h.anchor, storage.length))
        lm.ensureLayout(for: tc)
        let delta = lm.usedRect(for: tc).height - before
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: max(0, savedY + delta)))
        logScroll.reflectScrolledClipView(clip)
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
        appendAttributed(NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: color,
        ]))
    }

    private func appendAttributed(_ attr: NSAttributedString) {
        guard let storage = logView.textStorage else { return }
        if storage.length > 800_000 {
            storage.deleteCharacters(in: NSRange(location: 0, length: 200_000))
            // Keep the history anchor aligned with the trimmed buffer; give
            // up paging if the detail section itself was cut.
            if var h = detailHistory {
                h.anchor -= 200_000
                detailHistory = h.anchor >= 0 ? h : nil
            }
        }
        let atBottom = logView.visibleRect.maxY >= logView.bounds.maxY - 44
        storage.append(attr)
        if atBottom { logView.scrollToEndOfDocument(nil) }
    }

    // MARK: full-text HUD

    private func showFullText(_ text: String) {
        if hudPanel == nil {
            let panel = HUDPanel(
                contentRect: NSRect(x: 0, y: 0, width: 560, height: 420),
                styleMask: [.hudWindow, .utilityWindow, .titled, .closable, .resizable],
                backing: .buffered, defer: true)
            panel.title = "事件全文"
            panel.isFloatingPanel = true
            panel.isReleasedWhenClosed = false
            let scroll = NSTextView.scrollableTextView()
            scroll.drawsBackground = false
            let tv = scroll.documentView as! NSTextView
            tv.isEditable = false
            tv.drawsBackground = false
            tv.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            tv.textContainerInset = NSSize(width: 8, height: 8)
            panel.contentView = scroll
            hudPanel = panel
            hudTextView = tv
        }
        hudTextView?.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: NSColor.labelColor,
        ]))
        if let panel = hudPanel {
            if !panel.isVisible {
                let mouse = NSEvent.mouseLocation
                panel.setFrameTopLeftPoint(NSPoint(x: mouse.x + 16, y: mouse.y - 8))
            }
            panel.makeKeyAndOrderFront(nil)
            hudTextView?.scroll(.zero)
        }
    }

    fileprivate func showEventFullText(id: Int) {
        guard let raw = eventFullTexts[id] else {
            showFullText("（该条目已被清理）")
            return
        }
        // Pretty-print when the raw line is JSON; fall back to the raw text.
        if let data = raw.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data),
           let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
           let text = String(data: pretty, encoding: .utf8) {
            showFullText(text)
        } else {
            showFullText(raw)
        }
    }
}

extension MainViewController: NSTextViewDelegate {
    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        guard let str = link as? String, str.hasPrefix("orch-event://"),
              let id = Int(str.dropFirst("orch-event://".count)) else { return false }
        showEventFullText(id: id)
        return true
    }
}
