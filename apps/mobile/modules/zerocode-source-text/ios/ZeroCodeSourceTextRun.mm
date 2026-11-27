#import "ZeroCodeSourceTextRun.h"
#import <React/RCTFabricComponentsPlugins.h>
#import "ZeroCodeSourceTextRunComponentDescriptor.h"
#import <react/renderer/components/ZeroCodeSourceTextSpec/Props.h>
#import <react/renderer/components/ZeroCodeSourceTextSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface ZeroCodeSourceTextRun () <RCTZeroCodeSourceTextRunViewProtocol>

@end

@implementation ZeroCodeSourceTextRun {
  NSString *_text;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<
      ZeroCodeSourceTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const ZeroCodeSourceTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<ZeroCodeSourceTextRunProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<ZeroCodeSourceTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> ZeroCodeSourceTextRunCls(void) {
  return ZeroCodeSourceTextRun.class;
}

@end
