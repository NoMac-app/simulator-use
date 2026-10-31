import AVFoundation
import Contacts
import CoreLocation
import Photos
import SwiftUI
import UIKit
import UserNotifications
import WebKit

/// Everything an agent meets in real apps, one screen each: the simulator-use battle test.
@main
struct EdgeLabApp: App {
    @State private var deepLink = "none"
    var body: some Scene {
        WindowGroup {
            TabView {
                ControlsView().tabItem { Label("Controls", systemImage: "slider.horizontal.3") }
                DialogsView().tabItem { Label("Dialogs", systemImage: "exclamationmark.bubble") }
                ListsView().tabItem { Label("Lists", systemImage: "list.bullet") }
                TextView(deepLink: deepLink).tabItem { Label("Text", systemImage: "textformat") }
                MoreView().tabItem { Label("More", systemImage: "ellipsis") }
            }
            .onOpenURL { deepLink = $0.absoluteString }
        }
    }
}

struct ControlsView: View {
    @State private var volume = 30.0
    @State private var count = 2
    @State private var flavor = "Vanilla"
    @State private var size = "M"
    @State private var date = Date(timeIntervalSince1970: 1_800_000_000)
    @State private var notes = ""
    @State private var nickname = "prefilled"
    @State private var lastAction = "none"
    var body: some View {
        NavigationStack {
            Form {
                Section("Values") {
                    Slider(value: $volume, in: 0...100) { Text("Volume") }.accessibilityIdentifier("volume")
                    Stepper("Count: \(count)", value: $count, in: 0...10).accessibilityIdentifier("count")
                    Picker("Flavor", selection: $flavor) {
                        ForEach(["Vanilla", "Chocolate", "Strawberry"], id: \.self) { Text($0) }
                    }.accessibilityIdentifier("flavor")
                    Picker("Size", selection: $size) {
                        ForEach(["S", "M", "L"], id: \.self) { Text($0) }
                    }.pickerStyle(.segmented).accessibilityIdentifier("size")
                    DatePicker("Date", selection: $date, displayedComponents: .date).accessibilityIdentifier("date")
                }
                Section("Text") {
                    TextField("Nickname", text: $nickname).accessibilityIdentifier("nickname")
                    TextEditor(text: $notes).frame(height: 80).accessibilityIdentifier("notes")
                }
                Section("Buttons") {
                    Button("Disabled") {}.disabled(true).accessibilityIdentifier("disabled")
                    HStack {
                        Button { lastAction = "star" } label: { Image(systemName: "star") }.accessibilityLabel("Favorite")
                        Button { lastAction = "gear" } label: { Image(systemName: "gearshape") }
                        Menu("Sort") {
                            Button("Newest") { lastAction = "newest" }
                            Button("Oldest") { lastAction = "oldest" }
                        }.accessibilityIdentifier("sort")
                    }
                    Text("Last action: \(lastAction)").accessibilityIdentifier("lastAction")
                }
            }
            .navigationTitle("Controls")
        }
    }
}

final class LocationAsker: NSObject, CLLocationManagerDelegate {
    let manager = CLLocationManager()
    func ask() { manager.delegate = self; manager.requestWhenInUseAuthorization() }
}

struct DialogsView: View {
    @State private var showAlert = false
    @State private var showDialog = false
    @State private var showSheet = false
    @State private var showCover = false
    @State private var result = "nothing yet"
    @State private var asker = LocationAsker()
    var body: some View {
        NavigationStack {
            List {
                Button("Show alert") { showAlert = true }
                Button("Show choices") { showDialog = true }
                Button("Show sheet") { showSheet = true }
                Button("Show full screen") { showCover = true }
                Button("Ask for location") { asker.ask() }
                Button("Ask for photos") { PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in Task { @MainActor in result = "photos \(s.rawValue)" } } }
                Button("Ask for notifications") { UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { ok, _ in Task { @MainActor in result = "notifications \(ok)" } } }
                Button("Ask for contacts") { CNContactStore().requestAccess(for: .contacts) { ok, _ in Task { @MainActor in result = "contacts \(ok)" } } }
                Text("Result: \(result)").accessibilityIdentifier("dialogResult")
            }
            .navigationTitle("Dialogs")
            .alert("Delete everything?", isPresented: $showAlert) {
                Button("Delete", role: .destructive) { result = "deleted" }
                Button("Cancel", role: .cancel) { result = "cancelled" }
            } message: { Text("This cannot be undone.") }
            .confirmationDialog("Share how?", isPresented: $showDialog, titleVisibility: .visible) {
                Button("Copy link") { result = "copied" }
                Button("Email") { result = "emailed" }
            }
            .sheet(isPresented: $showSheet) {
                NavigationStack {
                    Text("A sheet").accessibilityIdentifier("sheetText")
                        .navigationTitle("Sheet")
                        .toolbar { Button("Done") { showSheet = false } }
                }
            }
            .fullScreenCover(isPresented: $showCover) {
                VStack(spacing: 20) {
                    Text("Full screen").font(.largeTitle)
                    Button("Close") { showCover = false }.accessibilityIdentifier("closeCover")
                }
            }
        }
    }
}

struct ListsView: View {
    @State private var rows = (1...30).map { "Row \($0)" }
    @State private var loaded = false
    @State private var toast = false
    @State private var picked = "none"
    var body: some View {
        NavigationStack {
            List {
                Section("Async") {
                    if loaded { Text("Loaded 20 results").accessibilityIdentifier("loaded") } else { ProgressView("Loading") }
                    Button("Show toast") { toast = true; DispatchQueue.main.asyncAfter(deadline: .now() + 2) { toast = false } }
                    if toast { Text("Saved!").accessibilityIdentifier("toast") }
                }
                Section("Carousel") {
                    ScrollView(.horizontal) {
                        HStack { ForEach(1...12, id: \.self) { i in Button("Card \(i)") { picked = "card \(i)" }.buttonStyle(.bordered) } }
                    }
                    Text("Picked: \(picked)").accessibilityIdentifier("picked")
                }
                Section("Rows") {
                    ForEach(rows, id: \.self) { row in
                        Text(row)
                            .contextMenu { Button("Pin \(row)") { picked = "pinned \(row)" } }
                    }
                    .onDelete { rows.remove(atOffsets: $0) }
                }
            }
            .navigationTitle("Lists")
            .task { try? await Task.sleep(for: .seconds(3)); loaded = true }
        }
    }
}

struct TextView: View {
    let deepLink: String
    @State private var search = ""
    @State private var unicode = ""
    var body: some View {
        NavigationStack {
            List {
                Text("Café crème · 日本語 · 🚀 rocket · مرحبا")
                Text("He said \"hi\"\nthen left")
                Text(String(repeating: "Long label ", count: 20))
                Button("Delete") {}
                Button("Delete") {}
                TextField("Unicode here", text: $unicode).accessibilityIdentifier("unicode")
                Text("Typed: \(unicode)").accessibilityIdentifier("typed")
                Text("Deep link: \(deepLink)").accessibilityIdentifier("deepLink")
                ForEach(["Apple", "Banana", "Cherry"].filter { search.isEmpty || $0.localizedCaseInsensitiveContains(search) }, id: \.self) { Text($0) }
            }
            .searchable(text: $search, prompt: "Search fruit")
            .navigationTitle("Text")
        }
    }
}

struct WebBox: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView()
        web.loadHTMLString("<html><body style='font:20px -apple-system;padding:20px'><h1>Web page</h1><input id='q' placeholder='Web field'><button onclick=\"document.getElementById('out').textContent='clicked'\">Web button</button><p id='out'>waiting</p></body></html>", baseURL: nil)
        return web
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

final class TableController: UITableViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "UIKit table"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "cell")
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { 25 }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "cell", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = "UIKit row \(indexPath.row + 1)"
        content.secondaryText = "detail \(indexPath.row + 1)"
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        let next = UIViewController()
        next.view.backgroundColor = .systemBackground
        let label = UILabel()
        label.text = "Picked UIKit row \(indexPath.row + 1)"
        label.accessibilityIdentifier = "uikitPicked"
        label.translatesAutoresizingMaskIntoConstraints = false
        next.view.addSubview(label)
        NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: next.view.centerXAnchor), label.centerYAnchor.constraint(equalTo: next.view.centerYAnchor)])
        navigationController?.pushViewController(next, animated: true)
    }
}

struct UIKitTable: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UINavigationController { UINavigationController(rootViewController: TableController()) }
    func updateUIViewController(_ controller: UINavigationController, context: Context) {}
}

/// Timing cases for simulator-use's settle (bench/hard.mjs): an answer that comes late, a push, a screen that never holds still.
struct TimingView: View {
    @State private var late = "Waiting"
    @State private var count = 0
    @State private var ticking = false
    @State private var ticks = 0
    var body: some View {
        List {
            Section("Late") {
                Button("Late 0.5") { answer(after: 0.5) }.accessibilityIdentifier("late05")
                Button("Late 1.0") { answer(after: 1.0) }.accessibilityIdentifier("late10")
                Button("Late 1.5") { answer(after: 1.5) }.accessibilityIdentifier("late15")
                Text(late).accessibilityIdentifier("lateStatus")
            }
            Section("Moving") {
                Button(ticking ? "Stop ticker" : "Start ticker") { ticking.toggle() }.accessibilityIdentifier("ticker")
                if ticking {
                    HStack {
                        ProgressView()
                        Text("Tick \(ticks)").monospacedDigit().accessibilityIdentifier("ticks")
                    }
                }
                Button("Count") { count += 1 }.accessibilityIdentifier("count")
                Text("Count: \(count)").accessibilityIdentifier("countLabel")
            }
            Section("Navigation") {
                NavigationLink("Push detail") {
                    Text("Detail page").accessibilityIdentifier("detailText").navigationTitle("Detail")
                }
                .accessibilityIdentifier("push")
            }
        }
        .navigationTitle("Timing")
        .task(id: ticking) {
            while ticking {
                try? await Task.sleep(for: .milliseconds(100))
                ticks += 1
            }
        }
    }

    private func answer(after seconds: Double) {
        late = "Waiting"
        Task {
            try? await Task.sleep(for: .seconds(seconds))
            late = "Done after \(seconds) s"
        }
    }
}

struct MoreView: View {
    var body: some View {
        NavigationStack {
            List {
                NavigationLink("Web page") { WebBox().navigationTitle("Web") }
                NavigationLink("UIKit table") { UIKitTable().ignoresSafeArea() }
                NavigationLink("Timing") { TimingView() }
            }
            .navigationTitle("More")
        }
    }
}
