import AppKit

final class MainViewController: NSViewController {
    private var logView: NSTextView!
    private let workspacePopup = NSPopUpButton()
    private let queryField = NSTextField()
    private let runButton = NSButton(title: "运行", target: nil, action: nil)
    private let spinner = NSProgressIndicator()

    private var workspaces: [Workspace] = []
    private var newTask: StreamTask?
    private var tailTask: StreamTask?

    var onWorkspaceChanged: ((Workspace) -> Void)?
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

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        let bar = NSStackView(views: [workspacePopup, queryField, runButton, spinner])
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
        onWorkspaceChanged?(ws)
    }

    // MARK: run

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

        tailTask = StreamTask(["events", "tail", "-f", "--native", "--worktree", ws.path],
                              cwd: ws.path) { [weak self] text in
            self?.appendLog(text, color: .secondaryLabelColor)
        }

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
            // drain trailing worker events, then stop the multiplexer
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.tailTask?.terminate()
                self?.tailTask = nil
            }
        }

        if newTask == nil {
            tailTask?.terminate()
            tailTask = nil
            setBusy(false)
            return
        }
        queryField.stringValue = ""
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.onRunsChanged?() }
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

    func inspectRun(_ info: RunInfo) {
        guard let ws = currentWorkspace else { return }
        appendLog("\n$ orch result --run \(info.run_id) --mr \(info.mr)\n", color: .systemBlue)
        Orch.capture(["result", "--run", info.run_id, "--mr", info.mr, "--worktree", ws.path]) {
            [weak self] data, err in
            if let err { self?.appendLog(err + "\n", color: .systemRed); return }
            if let data, let text = String(data: data, encoding: .utf8) {
                self?.appendLog(text.hasSuffix("\n") ? text : text + "\n")
            }
        }
    }

    func showError(_ message: String) {
        appendLog("⚠️ \(message)\n", color: .systemRed)
    }

    func stopAll() {
        newTask?.terminate()
        tailTask?.terminate()
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
