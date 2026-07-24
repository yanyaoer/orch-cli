import AppKit

final class MRNode {
    let mr: String
    var runs: [RunNode] = []
    var latest: String = ""
    init(mr: String) { self.mr = mr }
}

final class RunNode {
    let info: RunInfo
    init(_ info: RunInfo) { self.info = info }
}

final class SidebarViewController: NSViewController, NSOutlineViewDataSource, NSOutlineViewDelegate {
    private let outline = NSOutlineView()
    private var nodes: [MRNode] = []
    private var nodeByMR: [String: MRNode] = [:]
    private var timer: Timer?

    var onInspectRun: ((RunInfo) -> Void)?
    var onSelectRun: ((RunInfo?) -> Void)?
    var onError: ((String) -> Void)?
    // Suppresses selection callbacks while apply() rebuilds rows: reloadData
    // transiently clears the selection, which must not bounce the main view
    // back to the global stream on every 5s poll.
    private var isApplying = false

    var worktreePath: String? {
        didSet {
            guard worktreePath != oldValue else { return }
            nodes = []
            nodeByMR = [:]
            outline.reloadData()
            refresh(reportError: true)
        }
    }

    override func loadView() {
        let column = NSTableColumn(identifier: .init("main"))
        column.resizingMask = .autoresizingMask
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.style = .sourceList
        outline.rowHeight = 22
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.doubleAction = #selector(doubleClicked)

        let scroll = NSScrollView()
        scroll.documentView = outline
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        view = scroll
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func refresh(reportError: Bool = false) {
        guard let path = worktreePath else { return }
        Orch.capture(["status", "--json", "--worktree", path]) { [weak self] data, err in
            guard let self, self.worktreePath == path else { return }
            if let err {
                if reportError { self.onError?(err) }
                return
            }
            guard let data,
                  let status = try? JSONDecoder().decode(RepoStatus.self, from: data) else { return }
            self.apply(status)
        }
    }

    private func apply(_ status: RepoStatus) {
        let selectedID = (outline.item(atRow: outline.selectedRow) as? RunNode)?.info.run_id
        isApplying = true
        defer { isApplying = false }
        var fresh: [MRNode] = []
        var seen = Set<String>()
        for mr in status.mrs {
            seen.insert(mr.mr)
            let node: MRNode
            let isNew: Bool
            if let existing = nodeByMR[mr.mr] {
                node = existing
                isNew = false
            } else {
                node = MRNode(mr: mr.mr)
                nodeByMR[mr.mr] = node
                isNew = true
            }
            node.runs = mr.runs
                .sorted { ($0.updated_at ?? "") > ($1.updated_at ?? "") }
                .map(RunNode.init)
            node.latest = mr.runs.compactMap(\.updated_at).max() ?? ""
            fresh.append(node)
            if isNew { DispatchQueue.main.async { self.outline.expandItem(node) } }
        }
        nodeByMR = nodeByMR.filter { seen.contains($0.key) }
        nodes = fresh.sorted { $0.latest > $1.latest }
        outline.reloadData()
        // Restore the selection onto the recreated RunNode and hand the main
        // view the FRESH RunInfo (state may have changed → cancel button).
        var reselected: RunInfo?
        if let selectedID {
            outer: for mrNode in nodes {
                for runNode in mrNode.runs where runNode.info.run_id == selectedID {
                    let row = outline.row(forItem: runNode)
                    if row >= 0 {
                        outline.selectRowIndexes([row], byExtendingSelection: false)
                        reselected = runNode.info
                    }
                    break outer
                }
            }
        }
        onSelectRun?(reselected)
    }

    @objc private func doubleClicked() {
        guard let node = outline.item(atRow: outline.clickedRow) as? RunNode else { return }
        onInspectRun?(node.info)
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        guard !isApplying else { return }
        onSelectRun?((outline.item(atRow: outline.selectedRow) as? RunNode)?.info)
    }

    // MARK: NSOutlineViewDataSource

    func outlineView(_ v: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if item == nil { return nodes.count }
        return (item as? MRNode)?.runs.count ?? 0
    }

    func outlineView(_ v: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if let node = item as? MRNode { return node.runs[index] }
        return nodes[index]
    }

    func outlineView(_ v: NSOutlineView, isItemExpandable item: Any) -> Bool {
        (item as? MRNode)?.runs.isEmpty == false
    }

    // MARK: NSOutlineViewDelegate

    func outlineView(_ v: NSOutlineView, viewFor c: NSTableColumn?, item: Any) -> NSView? {
        let label = NSTextField(labelWithString: "")
        label.lineBreakMode = .byTruncatingMiddle
        label.allowsDefaultTighteningForTruncation = true

        if let node = item as? MRNode {
            label.font = .systemFont(ofSize: 12, weight: .semibold)
            label.stringValue = node.mr
            label.toolTip = node.mr
        } else if let node = item as? RunNode {
            let info = node.info
            let text = NSMutableAttributedString()
            text.append(NSAttributedString(string: "● ", attributes: [
                .foregroundColor: Self.stateColor(info.state),
                .font: NSFont.systemFont(ofSize: 12),
            ]))
            text.append(NSAttributedString(string: "\(info.role) · \(info.agent)", attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: NSFont.systemFont(ofSize: 12),
            ]))
            text.append(NSAttributedString(string: "  \(info.state)", attributes: [
                .foregroundColor: NSColor.secondaryLabelColor,
                .font: NSFont.systemFont(ofSize: 11),
            ]))
            label.attributedStringValue = text
            label.toolTip = info.run_id
        }

        let cell = NSTableCellView()
        cell.addSubview(label)
        cell.textField = label
        label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
            label.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -2),
            label.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    static func stateColor(_ state: String) -> NSColor {
        switch state {
        case "done": return .systemGreen
        case "failed", "timeout": return .systemRed
        case "running", "pending", "starting": return .systemOrange
        case "canceled": return .systemGray
        default: return .secondaryLabelColor
        }
    }
}
