import Foundation

struct Workspace: Decodable {
    let id: String
    let path: String
}

struct RunInfo: Decodable {
    let run_id: String
    let mr: String
    let role: String
    let agent: String
    let state: String
    let updated_at: String?
    let exit_code: Int?
    let worktree: String?
}

struct RunEntry {
    let info: RunInfo
    let runDir: String
    let decision: String?
}

struct MRGroup {
    let repoKey: String
    let mr: String
    var runs: [RunEntry]
    var latest: String
}

struct RepoGroup {
    let repoKey: String
    var mrs: [MRGroup]
    var latest: String
}

// Reads run records straight from the orch state tree
// (${XDG_STATE_HOME:-~/.local/state}/orch/<repo_key>/mrs/<mr>/runs/<run_id>/)
// instead of shelling out to `orch status`: every repo shows up regardless of
// the selected workspace, records survive deleted worktrees, and one
// malformed status.json skips a single row instead of blanking the tree.
final class StateScanner {
    static var stateRoot: String {
        let env = ProcessInfo.processInfo.environment
        let base = env["XDG_STATE_HOME"] ?? NSHomeDirectory() + "/.local/state"
        return base + "/orch"
    }

    // Non-repo bookkeeping dirs at the state root.
    private static let skippedRootDirs: Set<String> = [
        "dispatch", "worktree-locks", "mail", "mail-control", "chatgpt-bridge-locks",
    ]

    private struct CachedEntry {
        let statusMtime: Date
        let decisionMtime: Date?
        let entry: RunEntry
    }

    private var cache: [String: CachedEntry] = [:]
    private let fm = FileManager.default

    func scan() -> [RepoGroup] {
        var repos: [RepoGroup] = []
        for repoKey in findRepoKeys() {
            let mrsDir = "\(Self.stateRoot)/\(repoKey)/mrs"
            var groups: [MRGroup] = []
            for mr in (try? fm.contentsOfDirectory(atPath: mrsDir)) ?? [] {
                let runsDir = "\(mrsDir)/\(mr)/runs"
                var runs: [RunEntry] = []
                for runID in (try? fm.contentsOfDirectory(atPath: runsDir)) ?? [] {
                    if let entry = runEntry(runDir: "\(runsDir)/\(runID)") { runs.append(entry) }
                }
                guard !runs.isEmpty else { continue }
                runs.sort { ($0.info.updated_at ?? "") > ($1.info.updated_at ?? "") }
                let latest = runs.compactMap(\.info.updated_at).max() ?? ""
                groups.append(MRGroup(repoKey: repoKey, mr: mr, runs: runs, latest: latest))
            }
            guard !groups.isEmpty else { continue }
            groups.sort { $0.latest > $1.latest }
            repos.append(RepoGroup(repoKey: repoKey, mrs: groups, latest: groups.first?.latest ?? ""))
        }
        repos.sort { $0.latest > $1.latest }
        return repos
    }

    // Repo keys are nested paths (e.g. git.n.xiaomi.com/ai-framework/x-abc123):
    // walk down until a directory containing "mrs" appears.
    private func findRepoKeys() -> [String] {
        var keys: [String] = []
        func walk(_ dir: String, _ rel: String, depth: Int) {
            guard depth <= 4 else { return }
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: "\(dir)/mrs", isDirectory: &isDir), isDir.boolValue {
                keys.append(rel)
                return
            }
            for name in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] {
                if depth == 0 && Self.skippedRootDirs.contains(name) { continue }
                var sub: ObjCBool = false
                let path = "\(dir)/\(name)"
                if fm.fileExists(atPath: path, isDirectory: &sub), sub.boolValue {
                    walk(path, rel.isEmpty ? name : "\(rel)/\(name)", depth: depth + 1)
                }
            }
        }
        walk(Self.stateRoot, "", depth: 0)
        return keys
    }

    private func mtime(_ path: String) -> Date? {
        (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date
    }

    private func runEntry(runDir: String) -> RunEntry? {
        let statusPath = "\(runDir)/status.json"
        guard let statusM = mtime(statusPath) else { return nil }
        let decisionPath = "\(runDir)/decision.json"
        let decisionM = mtime(decisionPath)
        if let cached = cache[runDir], cached.statusMtime == statusM, cached.decisionMtime == decisionM {
            return cached.entry
        }
        guard let data = fm.contents(atPath: statusPath),
              let info = try? JSONDecoder().decode(RunInfo.self, from: data) else { return nil }
        struct Decision: Decodable { let verdict: String? }
        var verdict: String?
        if decisionM != nil, let d = fm.contents(atPath: decisionPath) {
            verdict = (try? JSONDecoder().decode(Decision.self, from: d))?.verdict
        }
        let entry = RunEntry(info: info, runDir: runDir, decision: verdict)
        cache[runDir] = CachedEntry(statusMtime: statusM, decisionMtime: decisionM, entry: entry)
        return entry
    }
}

func relativeTime(_ iso: String?) -> String {
    guard let iso else { return "" }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = parser.date(from: iso) ?? {
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: iso)
    }()
    guard let date else { return "" }
    let s = Int(-date.timeIntervalSinceNow)
    if s < 60 { return "\(max(s, 0))s" }
    if s < 3600 { return "\(s / 60)m" }
    if s < 86400 { return "\(s / 3600)h" }
    return "\(s / 86400)d"
}

enum Orch {
    static let binary: String = {
        let local = ("~/.local/bin/orch" as NSString).expandingTildeInPath
        return FileManager.default.isExecutableFile(atPath: local) ? local : ""
    }()

    static func process(_ args: [String], cwd: String? = nil) -> Process {
        let p = Process()
        if binary.isEmpty {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["orch"] + args
        } else {
            p.executableURL = URL(fileURLWithPath: binary)
            p.arguments = args
        }
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:"
            + (env["PATH"] ?? "/usr/bin:/bin")
        p.environment = env
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        p.standardInput = FileHandle.nullDevice
        return p
    }

    /// Run to completion off-main; callback on main with (stdout, errorMessage).
    static func capture(_ args: [String], cwd: String? = nil,
                        completion: @escaping (Data?, String?) -> Void) {
        DispatchQueue.global().async {
            let p = process(args, cwd: cwd)
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            do { try p.run() } catch {
                DispatchQueue.main.async { completion(nil, "无法启动 orch: \(error.localizedDescription)") }
                return
            }
            // read both pipes concurrently so a full stderr buffer can't deadlock the child
            let group = DispatchGroup()
            var outData = Data(), errData = Data()
            group.enter()
            DispatchQueue.global().async {
                outData = out.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }
            group.enter()
            DispatchQueue.global().async {
                errData = err.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }
            group.wait()
            p.waitUntilExit()
            DispatchQueue.main.async {
                if p.terminationStatus == 0 {
                    completion(outData, nil)
                } else {
                    let msg = String(data: errData, encoding: .utf8) ?? ""
                    completion(nil, "orch \(args.joined(separator: " ")) 退出码 \(p.terminationStatus)\n\(msg)")
                }
            }
        }
    }
}

/// Forwards a pipe's bytes as UTF-8 text, holding back incomplete trailing sequences.
final class PipeReader {
    private var carry = Data()

    init(_ pipe: Pipe, onText: @escaping (String) -> Void) {
        pipe.fileHandleForReading.readabilityHandler = { [self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            carry.append(data)
            if let s = String(data: carry, encoding: .utf8) {
                carry.removeAll()
                DispatchQueue.main.async { onText(s) }
            } else {
                for cut in 1...3 where carry.count > cut {
                    if let s = String(data: carry.prefix(carry.count - cut), encoding: .utf8) {
                        carry.removeFirst(carry.count - cut)
                        DispatchQueue.main.async { onText(s) }
                        break
                    }
                }
            }
        }
    }
}

/// One long-running orch child process with stdout+stderr streamed as text.
final class StreamTask {
    let process: Process
    private var readers: [PipeReader] = []

    var isRunning: Bool { process.isRunning }

    init?(_ args: [String], cwd: String? = nil,
          onText: @escaping (String) -> Void,
          onExit: ((Int32) -> Void)? = nil) {
        process = Orch.process(args, cwd: cwd)
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        readers = [PipeReader(out, onText: onText), PipeReader(err, onText: onText)]
        process.terminationHandler = { p in
            DispatchQueue.main.async { onExit?(p.terminationStatus) }
        }
        do { try process.run() } catch {
            DispatchQueue.main.async { onText("⚠️ 无法启动 orch: \(error.localizedDescription)\n") }
            return nil
        }
    }

    func interrupt() { if process.isRunning { process.interrupt() } }
    func terminate() { if process.isRunning { process.terminate() } }
}
