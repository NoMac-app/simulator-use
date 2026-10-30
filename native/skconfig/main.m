// skconfig: applies a StoreKit configuration (.storekit) to an app on an iOS Simulator, the way Xcode's Run does,
// so the app's StoreKit calls (products, purchases) use the file in the local StoreKit Testing environment, with no
// Apple Account and no change to the app. simulator-use runs it inside the phone:
//   xcrun simctl spawn <udid> simulator-use-skconfig apply <bundle-id> <file.storekit> [--dialogs]
//   xcrun simctl spawn <udid> simulator-use-skconfig remove <bundle-id>
// It uses Apple's StoreKitTest (SKTestSession, from the phone's own runtime) for another app's bundle ID, which
// storekitd takes from a process with the simulated entitlement Xcode's own helper (DTServiceHub) carries,
// com.apple.appstored.octane (skconfig.entitlements). Found on iOS 26.5 and 27.0, October 30, 2026: an XCTest bundle
// or a library injected into the app is refused ("not installed for development"); this is not.
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <dlfcn.h>

@interface NSObject (SKTestSession)
- (void)resetToDefaultState;
- (void)clearTransactions;
- (void)setDisableDialogs:(BOOL)value;
- (NSArray *)allTransactions;
- (void)removeConfigurationForBundleID:(NSString *)bundleID completion:(void (^)(NSError *))completion;
@end

static NSString *target;
static id targetBundleID(id self, SEL _cmd) { return target; }

/** SKTestSession for another app: its bundleID is the target's (the stock getter also needs XCTest, which is not here). */
static Class sessionClass(void) {
  if (!dlopen("/Developer/Library/Frameworks/StoreKitTest.framework/StoreKitTest", RTLD_NOW)) { fprintf(stderr, "StoreKitTest is not in this Simulator runtime: %s\n", dlerror()); return nil; }
  Class base = NSClassFromString(@"SKTestSession");
  if (!base) { fprintf(stderr, "SKTestSession is missing from StoreKitTest\n"); return nil; }
  Class cls = objc_getClass("SimulatorUseSession");
  if (!cls) {
    cls = objc_allocateClassPair(base, "SimulatorUseSession", 0);
    class_addMethod(cls, @selector(bundleID), (IMP)targetBundleID, "@@:");
    objc_registerClassPair(cls);
  }
  return cls;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 3 || (strcmp(argv[1], "apply") == 0 && argc < 4)) {
      fprintf(stderr, "usage: skconfig apply <bundle-id> <file.storekit> [--dialogs]\n       skconfig remove <bundle-id>\n");
      return 64;
    }
    target = @(argv[2]);
    if (strcmp(argv[1], "apply") == 0) {
      Class cls = sessionClass();
      if (!cls) return 2;
      BOOL dialogs = argc > 4 && strcmp(argv[4], "--dialogs") == 0;
      NSError *error = nil;
      id session = ((id (*)(id, SEL, NSURL *, NSError **))objc_msgSend)([cls alloc], @selector(initWithContentsOfURL:error:), [NSURL fileURLWithPath:@(argv[3])], &error);
      if (!session || error) { fprintf(stderr, "StoreKit did not take the file: %s\n", (error.localizedDescription ?: @"no session").UTF8String); return 3; }
      // The file's own starting state: its products and settings, and no purchases (an earlier one would make a
      // second purchase answer "already subscribed").
      [session resetToDefaultState];
      [session clearTransactions];
      // Without dialogs a purchase completes at once; iOS's purchase sheet is not in the app's accessibility tree.
      [session setDisableDialogs:!dialogs];
      printf("applied %s to %s\n", @(argv[3]).lastPathComponent.UTF8String, target.UTF8String);
      return 0;
    }
    if (strcmp(argv[1], "remove") == 0) {
      Protocol *protocol = sessionClass() ? objc_getProtocol("ASDOctaneServiceProtocol") : nil;
      if (!protocol) { fprintf(stderr, "StoreKit's testing service is not in this runtime\n"); return 4; }
      __block int status = 0;
      // The iOS SDK marks this initializer unavailable; the Simulator's Foundation has it.
      NSXPCConnection *connection = ((id (*)(id, SEL, NSString *, NSUInteger))objc_msgSend)([NSXPCConnection alloc], sel_registerName("initWithMachServiceName:options:"), @"com.apple.storekit.configuration.xpc", 0);
      connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:protocol];
      [connection resume];
      id proxy = [connection synchronousRemoteObjectProxyWithErrorHandler:^(NSError *e) { fprintf(stderr, "%s\n", e.localizedDescription.UTF8String); status = 5; }];
      [proxy removeConfigurationForBundleID:target completion:^(NSError *e) {
        if (e) { fprintf(stderr, "%s\n", e.localizedDescription.UTF8String); status = 6; }
      }];
      [connection invalidate];
      if (!status) printf("removed the StoreKit configuration of %s\n", target.UTF8String);
      return status;
    }
    fprintf(stderr, "unknown command %s\n", argv[1]);
    return 64;
  }
}
