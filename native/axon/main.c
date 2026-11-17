// simulator-use-axon: switches app accessibility on inside an iOS Simulator, run there by the engine
// (simctl spawn) as it opens its first automation session. It makes the call testmanagerd makes as it loads
// accessibility for a session (_AXSApplicationAccessibilitySetEnabled, libAccessibility), which has the phone's apps
// load accessibility now, while testmanagerd itself is still starting (7 to 17 s after a boot on a busy Mac), so its
// load then finds accessibility loaded and the session is answered at once. It is not a read of the phone: a read
// before accessibility is loaded leaves the phone's CoreSimulatorBridge an unknown accessibility client for good
// (native/engine/SessionWait.swift). Prints the state after the call; exits 1 when the call is not there.
#include <dlfcn.h>
#include <stdio.h>

int main(void) {
  void *ax = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW);
  if (!ax) { fprintf(stderr, "libAccessibility: %s\n", dlerror()); return 1; }
  void (*setEnabled)(int) = (void (*)(int))dlsym(ax, "_AXSApplicationAccessibilitySetEnabled");
  int (*enabled)(void) = (int (*)(void))dlsym(ax, "_AXSApplicationAccessibilityEnabled");
  if (!setEnabled) { fprintf(stderr, "no _AXSApplicationAccessibilitySetEnabled\n"); return 1; }
  setEnabled(1);
  printf("app accessibility %d\n", enabled ? enabled() : -1);
  return 0;
}
