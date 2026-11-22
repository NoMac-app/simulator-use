// A library loaded into an app that simulator-use launches on a Simulator (DYLD_INSERT_LIBRARIES, src/engine/apps.ts):
// every web view the app makes lets itself be inspected, as Safari's pages and a debug build of Capacitor do by
// default. simulator-use reads a web view's page through the Simulator's Web Inspector (src/web): since iOS 16.4 an
// app's WKWebView is not listed there unless the app sets isInspectable, and a web view hosted by SwiftUI cannot be
// read by accessibility at all on iOS 27, so without this such a screen is a blank to an agent.
//
// It changes nothing else, and only in the Simulator, in apps simulator-use starts: SIMULATOR_USE_WEB=off leaves it out.
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static void open_view(id view) {
  if (@available(iOS 16.4, *)) {
    if ([view isKindOfClass:[WKWebView class]] && ![(WKWebView *)view isInspectable]) [(WKWebView *)view setInspectable:YES];
  }
}

__attribute__((constructor)) static void simulator_use_open_web_views(void) {
  Class cls = [WKWebView class];
  {
    SEL sel = @selector(initWithFrame:configuration:);
    Method method = class_getInstanceMethod(cls, sel);
    typedef id (*Init)(id, SEL, CGRect, WKWebViewConfiguration *);
    Init original = (Init)method_getImplementation(method);
    if (original) {
      method_setImplementation(method, imp_implementationWithBlock(^id(id self, CGRect frame, WKWebViewConfiguration *configuration) {
        id view = original(self, sel, frame, configuration);
        open_view(view);
        return view;
      }));
    }
  }
  {
    SEL sel = @selector(initWithCoder:);
    Method method = class_getInstanceMethod(cls, sel);
    typedef id (*Init)(id, SEL, NSCoder *);
    Init original = (Init)method_getImplementation(method);
    if (original) {
      method_setImplementation(method, imp_implementationWithBlock(^id(id self, NSCoder *coder) {
        id view = original(self, sel, coder);
        open_view(view);
        return view;
      }));
    }
  }
}
