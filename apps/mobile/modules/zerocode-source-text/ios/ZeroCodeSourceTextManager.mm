#import <React/RCTUIManager.h>
#import <React/RCTViewManager.h>

@interface ZeroCodeSourceTextManager : RCTViewManager
@end

@implementation ZeroCodeSourceTextManager

RCT_EXPORT_MODULE(ZeroCodeSourceText)

- (UIView *)view {
  return [[UIView alloc] init];
}

@end

@interface ZeroCodeSourceTextRunManager : RCTViewManager
@end

@implementation ZeroCodeSourceTextRunManager

RCT_EXPORT_MODULE(ZeroCodeSourceTextRun)

- (UIView *)view {
  return nil;
}

@end
