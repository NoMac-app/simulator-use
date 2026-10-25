// Sets or prints the Simulator's own pasteboard from inside the phone (simctl spawn), without the host's pasteboard,
// which a user with no screen session does not have. pbset - sets it to its input (simctl spawn passes stdin on), so
// the text is never in an argument other users of the host can read; pbset with no argument prints it.
#import <UIKit/UIKit.h>
int main(int argc, char *argv[]) {
  @autoreleasepool {
    UIPasteboard *pb = [UIPasteboard generalPasteboard];
    long before = (long)pb.changeCount;
    if (argc > 1) {
      if (strcmp(argv[1], "-") != 0) {
        fprintf(stderr, "usage: pbset - (the text on stdin), or pbset to print the pasteboard\n");
        return 2;
      }
      NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
      NSString *text = [[NSString alloc] initWithData:input encoding:NSUTF8StringEncoding];
      if (!text) {
        fprintf(stderr, "the input is not UTF-8\n");
        return 1;
      }
      [pb setItems:@[@{@"public.utf8-plain-text": text}] options:@{}];
      // The pasteboard server takes the write asynchronously: give it a moment before the process exits.
      [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.5]];
      fprintf(stderr, "changeCount %ld -> %ld, hasStrings %d\n", before, (long)pb.changeCount, pb.hasStrings);
    } else {
      fprintf(stderr, "changeCount %ld, hasStrings %d\n", before, pb.hasStrings);
      printf("%s\n", (pb.string ?: @"").UTF8String);
    }
  }
  return 0;
}
