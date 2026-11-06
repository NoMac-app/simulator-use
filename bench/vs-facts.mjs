// Every claim the /vs pages make about a tool, with the sources it was read from (October 31, 2026; a tool's
// readOn says when it was read later). bench/vs.mjs
// puts these beside the measured numbers from a benchmark run. A claim lists the keys of its sources; a page links
// each one. Numbers never live here: they come from bench/results/<date>/summary.json and the raw results.
export const READ_ON = "October 31, 2026";
export const INSTALL = "claude mcp add simulator-use -- npx -y simulator-use mcp";

const GH = (repo, path = "") => `https://github.com/${repo}${path ? `/blob/main/${path}` : ""}`;
const RESULTS = (file, date = "2026-10-31") => `https://github.com/NoMac-app/simulator-use/blob/main/bench/results/${date}/${file}`;

export const SOURCES = {
  "su-readme": ["simulator-use README", GH("NoMac-app/simulator-use")],
  "su-license": ["simulator-use LICENSE", GH("NoMac-app/simulator-use", "LICENSE")],
  "xc-agents": ["Apple: Giving external agents access to Xcode", "https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode"],
  "xc-notes": ["Apple: Xcode 27 release notes", "https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes"],
  "xc-tools": ["Xcode MCP's tool list, as the benchmark recorded it", RESULTS("xcode-mcp.tools.json")],
  "ar-readme": ["Argent README", GH("software-mansion/argent")],
  "ar-license": ["Argent LICENSE", GH("software-mansion/argent", "LICENSE.txt")],
  "ar-tools": ["Argent docs: tools reference", "https://docs.swmansion.com/argent/docs/reference/tools"],
  "ar-platforms": ["Argent docs: supported platforms", "https://docs.swmansion.com/argent/docs/fundamentals/supported-platforms"],
  "ar-install": ["Argent docs: installation", "https://docs.swmansion.com/argent/docs/fundamentals/installation"],
  "ar-cloud": ["Argent docs: Argent Cloud", "https://docs.swmansion.com/argent/docs/cloud/fundamentals/getting-started"],
  "ar-interact": ["Argent docs: interacting with apps", "https://docs.swmansion.com/argent/docs/features/interacting-with-apps"],
  "ad-readme": ["agent-device README", GH("callstack/agent-device")],
  "ad-license": ["agent-device LICENSE", GH("callstack/agent-device", "LICENSE")],
  "ad-tools": ["agent-device's MCP instructions, as the benchmark recorded them", RESULTS("agent-device.tools.json")],
  "ad-commands": ["agent-device docs: commands (app install)", "https://agent-device.dev/docs/commands"],
  "mm-readme": ["mobile-mcp README", GH("mobile-next/mobile-mcp")],
  "mm-license": ["mobile-mcp LICENSE", GH("mobile-next/mobile-mcp", "LICENSE")],
  "mc-readme": ["mobilecli README", GH("mobile-next/mobilecli")],
  "mc-license": ["mobilecli LICENSE", GH("mobile-next/mobilecli", "LICENSE")],
  "ma-readme": ["Maestro README", GH("mobile-dev-inc/Maestro")],
  "ma-license": ["Maestro LICENSE", GH("mobile-dev-inc/Maestro", "LICENSE")],
  "ma-mcp": ["Maestro docs: Maestro MCP", "https://docs.maestro.dev/get-started/maestro-mcp"],
  "ma-how": ["Maestro docs: how Maestro works", "https://docs.maestro.dev/get-started/how-maestro-works"],
  "ma-build": ["Maestro docs: build your app for the cloud", "https://docs.maestro.dev/maestro-cloud/build-your-app-for-the-cloud"],
  "ma-inspect": ["Maestro's inspect_screen tool", GH("mobile-dev-inc/Maestro", "maestro-cli/src/main/java/maestro/cli/mcp/tools/InspectScreenTool.kt")],
  "axe-readme": ["AXe README", "https://github.com/cameroncooke/AXe#xcode-compatibility"],
  "axe-license": ["AXe LICENSE", GH("cameroncooke/AXe", "LICENSE")],
  "axe-docs": ["AXe docs", "https://axe-cli.com/docs"],
  "mb-readme": ["MobileBuildMCP README", GH("getsentry/MobileBuildMCP")],
  "mb-license": ["MobileBuildMCP LICENSE", GH("getsentry/MobileBuildMCP", "LICENSE")],
  "mb-changelog": ["MobileBuildMCP CHANGELOG", GH("getsentry/MobileBuildMCP", "CHANGELOG.md")],
  "mb-ui": ["MobileBuildMCP docs: UI automation", GH("getsentry/xcodebuildmcp.com", "app/docs/_content/architecture-ui-automation.mdx")],
  "mb-tap": ["MobileBuildMCP's tap tool", GH("getsentry/MobileBuildMCP", "manifests/tools/tap.yaml")],
  "mb-workflows": ["MobileBuildMCP workflows", "https://github.com/getsentry/MobileBuildMCP/tree/main/manifests/workflows"],
  "mb-tools": ["MobileBuildMCP's tool list, as the benchmark recorded it", RESULTS("mobilebuildmcp.tools.json")],
  "ism-readme": ["ios-simulator-mcp README", GH("joshuayoes/ios-simulator-mcp")],
  "ism-license": ["ios-simulator-mcp LICENSE", GH("joshuayoes/ios-simulator-mcp", "LICENSE")],
  "ism-troubleshooting": ["ios-simulator-mcp TROUBLESHOOTING (installing IDB)", GH("joshuayoes/ios-simulator-mcp", "TROUBLESHOOTING.md")],
  "ism-tools": ["ios-simulator-mcp's tool list, as the benchmark recorded it", RESULTS("ios-simulator-mcp.tools.json", "2026-11-06")],
};

const c = (t, ...s) => ({ t, s });

// The rows of "What each does", for simulator-use and each tool.
export const TOOLS = {
  "simulator-use": {
    name: "simulator-use",
    facts: {
      license: c("MIT", "su-license"),
      builds: c("Yes: builds the Xcode project, installs and launches it (app_run)", "su-readme"),
      tests: c("XCTest and XCUITest, case by case (tests_run)", "su-readme"),
      screen: c("One line per element: kind, label, #id, state and position", "su-readme"),
      taps: c("By #id or label, or at @x,y", "su-readme"),
      cloud: c("A NoMac cloud iPhone (simulator-use cloud start), billed per minute", "su-readme"),
      needs: c("Node 20. Its engine is built on AXe's frameworks, which it bundles", "su-readme"),
    },
  },

  "xcode-mcp": {
    slug: "xcode-mcp", name: "Xcode MCP", run: "xcode-mcp",
    calls: [
      { step: "Build, install and launch", them: c("BuildProject, or DeviceInteractionInstallAndRun", "xc-tools"), us: c("app_run", "su-readme") },
      { step: "Run the tests", them: c("RunAllTests or RunSomeTests", "xc-tools"), us: c("tests_run", "su-readme") },
    ],
    facts: {
      license: c("Part of Xcode", "xc-agents"),
      builds: c("Yes: BuildProject, and DeviceInteractionInstallAndRun builds, installs and launches", "xc-tools"),
      tests: c("Yes: RunAllTests and RunSomeTests", "xc-tools"),
      screen: c("A UI hierarchy file and a screenshot per interaction, answered as file paths", "xc-tools"),
      taps: c("At coordinates (t x y), taken from the hierarchy's hit points", "xc-tools"),
      cloud: c("None in Apple's docs", "xc-agents"),
      needs: c("Xcode 27, with sudo xcrun mcp-server enable, or Xcode open with \"Allow external agents to use Xcode tools\" turned on", "xc-notes", "xc-agents"),
    },
    pickThem: c("Pick Xcode MCP if you work in Xcode 27 and want Apple's own agent tools: they come with Xcode and reach its build settings, schemes, previews and debugger as well as the Simulator.", "xc-agents", "xc-tools"),
    pickUs: c("Pick simulator-use if the agent should get the screen as text in each answer and tap by label or id rather than at coordinates, from any MCP client, without turning on Xcode's agent access.", "su-readme", "xc-tools", "xc-notes"),
    them: [
      c("Nothing else to install: it comes with Xcode 27.", "xc-agents", "xc-notes"),
      c("Its tools reach into Xcode itself: build settings, schemes and test plans, SwiftUI previews, the debugger, string catalogs and crash reports.", "xc-tools"),
      c("Apple's release notes say agents can also verify watchOS and tvOS apps with it.", "xc-notes"),
    ],
    us: [
      c("The screen comes back as text in the answer; Xcode MCP answers with paths to a hierarchy file and a screenshot that the agent opens.", "su-readme", "xc-tools"),
      c("Taps go to an element by #id or label; Xcode MCP taps at coordinates from the last hierarchy it read.", "su-readme", "xc-tools"),
    ],
  },

  argent: {
    slug: "argent", name: "Argent", run: "argent",
    facts: {
      license: c("Apache 2.0 source; its simulator-server and ax-service binaries are proprietary", "ar-readme", "ar-license"),
      builds: c("React Native projects", "ar-readme"),
      tests: c("Records a path as an e2e test and replays it", "ar-readme"),
      screen: c("An element tree, and a screenshot and element tree after each action", "ar-tools"),
      taps: c("At coordinates from 0 to 1, taken from its element tree", "ar-tools", "ar-platforms"),
      cloud: c("Argent Cloud", "ar-cloud"),
      needs: c("Node 20.12. Software Mansion's proprietary simulator-server and ax-service binaries", "ar-install", "ar-readme"),
    },
    pickThem: c("Pick Argent for React Native apps: it builds and runs React Native projects, profiles Hermes and React renders, and also drives Android, TV and Electron apps.", "ar-readme"),
    pickUs: c("Pick simulator-use for native Xcode projects, which it builds and tests with XCTest and XCUITest, and taps by label or id instead of screen fractions.", "su-readme", "ar-tools"),
    them: [
      c("React Native: build, launch and iterate with no extra setup, plus Hermes, React DevTools and Instruments profiling.", "ar-readme"),
      c("Beyond the iOS Simulator: Android emulators and devices, TVs and Electron or Chromium apps.", "ar-readme"),
      c("Each interaction answers with a screenshot and the element tree of the settled screen, so the next step needs no extra read.", "ar-tools", "ar-interact"),
    ],
    us: [
      c("Builds a native Xcode project and runs its XCTest and XCUITest cases.", "su-readme"),
      c("MIT throughout, the AXe and IDB frameworks it bundles included; Argent's simulator-server and ax-service binaries are proprietary.", "su-readme", "ar-readme"),
    ],
  },

  "agent-device": {
    slug: "agent-device", name: "agent-device", run: "agent-device",
    facts: {
      license: c("MIT", "ad-license"),
      builds: c("No; it installs an app built elsewhere", "ad-commands"),
      tests: c("Replays its own .ad scripts", "ad-readme"),
      screen: c("Snapshots with refs, and settled diffs after actions", "ad-readme"),
      taps: c("By ref, then id, label or role selector; coordinates last", "ad-tools"),
      cloud: c("A remote proxy, or device clouds: BrowserStack, AWS Device Farm, TestMu AI, Limrun", "ad-readme"),
      needs: c("Node 22.12. A local accessibility bridge for Simulator snapshots and XCTest for iOS interactions", "ad-readme"),
    },
    pickThem: c("Pick agent-device if your agent works across platforms (Android, HarmonyOS, TV, macOS, Linux, web) or several agents share one machine: it scopes sessions to each git worktree and replays saved .ad scripts in CI.", "ad-readme"),
    pickUs: c("Pick simulator-use to build and test the Xcode project with the same tool that drives the screen.", "su-readme", "ad-commands"),
    them: [
      c("iOS, Android and HarmonyOS, plus tvOS, Android TV, Fire TV, macOS, Linux and web.", "ad-readme"),
      c("Sessions are scoped to each git worktree, and device claims keep parallel agents off each other's simulators.", "ad-readme"),
      c("Runs can be saved as .ad scripts and replayed in CI, or exported as Maestro YAML.", "ad-readme"),
    ],
    us: [
      c("Builds the Xcode project, installs and launches it, and runs its XCTest and XCUITest cases.", "su-readme"),
    ],
  },

  "mobile-mcp": {
    slug: "mobile-mcp", name: "mobile-mcp", run: "mobile-mcp",
    facts: {
      license: c("Apache 2.0; built on mobilecli, which is under the Functional Source License 1.1", "mm-license", "mm-readme", "mc-license"),
      builds: c("No; it installs an .app, .ipa, .apk or .zip", "mm-readme"),
      tests: c("None in its README", "mm-readme"),
      screen: c("One line per element, with refs", "mm-readme"),
      taps: c("By ref from its element list, or at x,y coordinates", "mm-readme"),
      cloud: c("Mobile Next Cloud: real iOS and Android devices", "mm-readme"),
      needs: c("Node 20 and the Xcode command line tools. On iOS, mobilecli's on-device agent is required for touch input and UI tree inspection", "mm-readme", "mc-readme"),
    },
    pickThem: c("Pick mobile-mcp to drive real iOS and Android devices, over USB or on Mobile Next Cloud, with the same tools as simulators and emulators.", "mm-readme"),
    pickUs: c("Pick simulator-use to build and test the Xcode project with the same tool, and for taps whose answer says what changed on screen.", "su-readme", "mm-readme"),
    them: [
      c("Real devices as well as simulators and emulators, iOS and Android.", "mm-readme"),
      c("Mobile Next Cloud: real iOS and Android devices from the same tools.", "mm-readme"),
    ],
    us: [
      c("Builds the Xcode project and runs its XCTest and XCUITest cases; mobile-mcp installs an app built elsewhere.", "su-readme", "mm-readme"),
      c("MIT throughout, the AXe and IDB frameworks it bundles included; mobile-mcp is built on mobilecli, which is under the Functional Source License 1.1.", "su-readme", "mm-readme", "mc-license"),
    ],
  },

  maestro: {
    slug: "maestro-mcp", name: "Maestro MCP", run: "maestro",
    facts: {
      license: c("Apache 2.0", "ma-license"),
      builds: c("No; its flows run on an app you build", "ma-build"),
      tests: c("Maestro flows (YAML)", "ma-readme", "ma-mcp"),
      screen: c("A compact JSON view hierarchy", "ma-mcp"),
      taps: c("tapOn by text or id selectors in a flow", "ma-inspect"),
      cloud: c("Maestro Cloud runs flows", "ma-mcp"),
      needs: c("Java 17. It installs a small companion driver app on the device", "ma-readme", "ma-how"),
    },
    pickThem: c("Pick Maestro if you want tests as Maestro flows: YAML files kept in the repo and run locally or on Maestro Cloud, on Android, iOS and web.", "ma-readme", "ma-mcp"),
    pickUs: c("Pick simulator-use to build the app and run its XCTest and XCUITest cases, and to read and act on the screen with single calls instead of flows.", "su-readme", "ma-build"),
    them: [
      c("Tests are flows, a flat list of YAML commands, that run the same locally and on Maestro Cloud.", "ma-readme", "ma-mcp"),
      c("Android emulators, iOS simulators and Chromium for web from one server.", "ma-mcp"),
    ],
    us: [
      c("Builds the Xcode project and runs its XCTest and XCUITest cases.", "su-readme"),
      c("No Java needed; Maestro needs Java 17.", "su-readme", "ma-readme"),
    ],
  },

  axe: {
    slug: "axe", name: "AXe", run: "axe",
    facts: {
      license: c("MIT", "axe-license"),
      builds: c("No", "axe-docs"),
      tests: c("No", "axe-docs"),
      screen: c("The accessibility tree as JSON (describe-ui)", "axe-docs"),
      taps: c("By accessibility id or label, or at coordinates", "axe-docs", "axe-readme"),
      cloud: c("None in its docs", "axe-docs"),
      needs: c("macOS 14 or later. \"Xcode 27 simulator automation uses Device Hub; Simulator.app is not required.\"", "axe-docs", "axe-readme"),
    },
    pickThem: c("Pick AXe for a command line with no MCP server: shell scripts, CI jobs, or agents that run commands. simulator-use is built on AXe's frameworks.", "axe-docs", "su-readme"),
    pickUs: c("Pick simulator-use for an MCP server on the same frameworks that also builds and tests the app and reads the screen as one line per element.", "su-readme"),
    them: [
      c("Screenshots, video recording and frame streaming from the same command.", "axe-docs"),
    ],
    us: [
      c("An MCP server, building and testing the Xcode project, on AXe's own frameworks.", "su-readme"),
    ],
    deviceHub: true,
  },

  mobilebuildmcp: {
    calls: [
      { step: "Build, install and launch", them: c("build_run_sim", "mb-tools"), us: c("app_run", "su-readme") },
      { step: "Run the tests", them: c("test_sim", "mb-tools"), us: c("tests_run", "su-readme") },
    ],
    slug: "mobilebuildmcp", name: "MobileBuildMCP", long: "MobileBuildMCP (formerly XcodeBuildMCP)", run: "mobilebuildmcp",
    formerly: c("Before version 2.7.1, MobileBuildMCP was called XcodeBuildMCP; its changelog for 2.7.1: \"Renamed the project from XcodeBuildMCP to MobileBuildMCP.\"", "mb-changelog"),
    facts: {
      license: c("MIT", "mb-license"),
      builds: c("Yes, for the Simulator, devices and macOS", "mb-readme", "mb-workflows"),
      tests: c("Yes", "mb-readme"),
      screen: c("Its tap targets, with refs (snapshot_ui)", "mb-ui"),
      taps: c("By elementRef from its latest snapshot", "mb-tap"),
      cloud: c("None in its README", "mb-readme"),
      needs: c("macOS 14.5, Xcode 16 and Node 18. Reads and taps through a bundled AXe", "mb-readme", "mb-ui"),
    },
    pickThem: c("Pick MobileBuildMCP for a wider Xcode workflow from one server: builds for the Simulator, devices and macOS, Swift packages, code coverage and LLDB debugging.", "mb-workflows"),
    pickUs: c("Pick simulator-use for driving the Simulator's screen: it reads and taps through its own long-lived engine on AXe's frameworks, where MobileBuildMCP asks its bundled AXe for each read and action.", "su-readme", "mb-ui"),
    them: [
      c("Workflows beyond the Simulator: devices, macOS, Swift packages, code coverage, LLDB debugging and project scaffolding.", "mb-workflows"),
    ],
    us: [
      c("Typing is one call per field that reads the text back. MobileBuildMCP's refs belong to its latest snapshot and its tools say to refresh after layout changes, so in the benchmark it read the screen again after each typing (counted in its sign-in).", "su-readme", "mb-tap"),
    ],
    deviceHub: true,
  },

  // Read on November 4, 2026, at its 2.2.0 release.
  "ios-simulator-mcp": {
    slug: "ios-simulator-mcp", name: "ios-simulator-mcp", run: "ios-simulator-mcp", readOn: "November 4, 2026",
    calls: [
      { step: "Build, install and launch", them: c("No build: install_app with a built .app or .ipa, then launch_app", "ism-readme"), us: c("app_run", "su-readme") },
    ],
    facts: {
      license: c("MIT", "ism-license"),
      builds: c("No; it installs a built .app or .ipa (install_app)", "ism-readme"),
      tests: c("None in its README", "ism-readme"),
      screen: c("The accessibility tree as JSON, from IDB (ui_describe_all), or a compressed screenshot (ui_view)", "ism-readme", "ism-tools"),
      taps: c("At x,y coordinates (ui_tap)", "ism-readme"),
      cloud: c("None in its README", "ism-readme"),
      needs: c("Node 20 and Facebook's IDB: the idb_companion binary (Homebrew) and the fb-idb Python client", "ism-readme", "ism-troubleshooting"),
    },
    pickThem: c("Pick ios-simulator-mcp for a small set of Simulator tools on Facebook's IDB that also shows the agent a screenshot (ui_view), records video, opens deep links and pastes text on non-US keyboard layouts.", "ism-readme"),
    pickUs: c("Pick simulator-use to build and test the Xcode project with the same tool, to get the screen as one line per element, and to tap by label or id instead of at coordinates, with nothing to install besides Node.", "su-readme", "ism-readme", "ism-troubleshooting"),
    them: [
      c("ui_view answers with a compressed screenshot the agent sees as an image, beside the accessibility tree.", "ism-readme"),
      c("ui_type can paste text through the Simulator's pasteboard, for non-US keyboard layouts and non-ASCII text, and taps iOS's Allow Paste prompt itself.", "ism-readme"),
      c("IOS_SIMULATOR_MCP_FILTERED_TOOLS leaves the tools an agent doesn't need out of its list.", "ism-readme"),
    ],
    us: [
      c("Builds the Xcode project, installs and launches it, and runs its XCTest and XCUITest cases; ios-simulator-mcp installs an app built elsewhere.", "su-readme", "ism-readme"),
      c("Taps go to an element by #id or label; ios-simulator-mcp taps at coordinates the agent works out from the frames in the tree.", "su-readme", "ism-readme"),
      c("Nothing to install besides Node: its engine bundles AXe's frameworks, the IDB frameworks among them. ios-simulator-mcp needs idb_companion from Homebrew and the fb-idb Python client.", "su-readme", "ism-troubleshooting"),
    ],
  },
};

// The Device Hub finding: the README line it tests, and MobileBuildMCP's own changelog on Device Hub.
export const DEVICE_HUB = {
  axeQuote: c("Xcode 27 simulator automation uses Device Hub; Simulator.app is not required.", "axe-readme"),
  mbQuote: c("UI automation tools now work fully with Xcode 27 simulators through Device Hub", "mb-changelog"),
};
