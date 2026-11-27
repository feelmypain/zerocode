#import "ZeroCodeSourceText.h"
#import <React/RCTFabricComponentsPlugins.h>
#import "ZeroCodeSourceTextComponentDescriptor.h"
#import "ZeroCodeSourceTextShadowNode.h"
#import <React/RCTConversions.h>
#import <objc/runtime.h>
#import <react/renderer/components/ZeroCodeSourceTextSpec/EventEmitters.h>
#import <react/renderer/components/ZeroCodeSourceTextSpec/Props.h>
#import <react/renderer/components/ZeroCodeSourceTextSpec/RCTComponentViewHelpers.h>
#import <react/renderer/textlayoutmanager/RCTAttributedTextUtils.h>

using namespace facebook::react;

@interface ZeroCodeSourceTextView : UITextView
@end

@implementation ZeroCodeSourceTextView
- (BOOL)canPerformAction:(SEL)action withSender:(id)sender {
  // Read-only UITextViews must still allow selecting the whole file.
  if (action == @selector(selectAll:)) {
    return self.selectable && self.text.length > 0 &&
           self.selectedRange.length < self.text.length;
  }
  return [super canPerformAction:action withSender:sender];
}
@end

@protocol ZeroCodeSourceTextOutsideTapTarget <NSObject>
- (void)clearSelectionForOutsideTapWithHitView:(UIView *)hitView;
@end

@interface ZeroCodeSourceTextOutsideTapCoordinator
    : NSObject <UIGestureRecognizerDelegate>

- (instancetype)initWithWindow:(UIWindow *)window;
- (void)addTarget:(id<ZeroCodeSourceTextOutsideTapTarget>)target;
- (void)removeTarget:(id<ZeroCodeSourceTextOutsideTapTarget>)target;

@end

static const void *ZeroCodeSourceTextOutsideTapCoordinatorKey =
    &ZeroCodeSourceTextOutsideTapCoordinatorKey;

@implementation ZeroCodeSourceTextOutsideTapCoordinator {
  __weak UIWindow *_window;
  UITapGestureRecognizer *_recognizer;
  NSHashTable<id<ZeroCodeSourceTextOutsideTapTarget>> *_targets;
}

- (instancetype)initWithWindow:(UIWindow *)window {
  if (self = [super init]) {
    _window = window;
    _targets = [NSHashTable weakObjectsHashTable];
    _recognizer =
        [[UITapGestureRecognizer alloc] initWithTarget:self
                                                action:@selector(handleTap:)];
    _recognizer.cancelsTouchesInView = NO;
    _recognizer.delegate = self;
    [window addGestureRecognizer:_recognizer];
  }
  return self;
}

- (void)addTarget:(id<ZeroCodeSourceTextOutsideTapTarget>)target {
  [_targets addObject:target];
}

- (void)removeTarget:(id<ZeroCodeSourceTextOutsideTapTarget>)target {
  [_targets removeObject:target];
  if (_targets.count > 0) {
    return;
  }

  UIWindow *window = _window;
  [window removeGestureRecognizer:_recognizer];
  if (objc_getAssociatedObject(window, ZeroCodeSourceTextOutsideTapCoordinatorKey) ==
      self) {
    objc_setAssociatedObject(window, ZeroCodeSourceTextOutsideTapCoordinatorKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}

- (void)handleTap:(UITapGestureRecognizer *)sender {
  UIWindow *window = _window;
  if (window == nil) {
    return;
  }

  UIView *hitView = [window hitTest:[sender locationInView:window]
                          withEvent:nil];
  if (hitView == nil) {
    return;
  }
  for (id<ZeroCodeSourceTextOutsideTapTarget> target in _targets.allObjects) {
    [target clearSelectionForOutsideTapWithHitView:hitView];
  }
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
    shouldRecognizeSimultaneouslyWithGestureRecognizer:
        (UIGestureRecognizer *)otherGestureRecognizer {
  return YES;
}

@end

static ZeroCodeSourceTextOutsideTapCoordinator *
ZeroCodeSourceTextOutsideTapCoordinatorForWindow(UIWindow *window) {
  ZeroCodeSourceTextOutsideTapCoordinator *coordinator =
      objc_getAssociatedObject(window, ZeroCodeSourceTextOutsideTapCoordinatorKey);
  if (coordinator == nil) {
    coordinator =
        [[ZeroCodeSourceTextOutsideTapCoordinator alloc] initWithWindow:window];
    objc_setAssociatedObject(window, ZeroCodeSourceTextOutsideTapCoordinatorKey,
                             coordinator, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return coordinator;
}

@interface ZeroCodeSourceText () <RCTZeroCodeSourceTextViewProtocol, UITextViewDelegate,
                            ZeroCodeSourceTextOutsideTapTarget>
@end

@implementation ZeroCodeSourceText {
  UIView *_view;
  ZeroCodeSourceTextView *_textView;
  ZeroCodeSourceTextShadowNode::ConcreteState::Shared _state;
  ZeroCodeSourceTextShadowNode::ConcreteState::Shared _appliedState;
  __weak UIWindow *_outsideTapWindow;
  BOOL _suppressSelectionChange;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<ZeroCodeSourceTextComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const ZeroCodeSourceTextProps>();
    _props = defaultProps;
    _view = [[UIView alloc] init];
    self.contentView = _view;
    self.clipsToBounds = YES;
    _textView = [[ZeroCodeSourceTextView alloc] init];
    _textView.scrollEnabled = NO;
    _textView.editable = NO;
    _textView.textContainerInset = UIEdgeInsetsZero;
    _textView.textContainer.lineFragmentPadding = 0;
    _textView.textContainer.lineBreakMode = NSLineBreakByTruncatingTail;
    _textView.textContainer.widthTracksTextView = NO;
    _textView.textContainer.heightTracksTextView = NO;
    _textView.delegate = self;
    _textView.textDragInteraction.enabled = NO;
    _textView.layoutManager.usesFontLeading = NO;
    [self addSubview:_textView];
  }
  return self;
}

- (void)didMoveToWindow {
  [super didMoveToWindow];
  if (_outsideTapWindow == self.window)
    return;
  ZeroCodeSourceTextOutsideTapCoordinator *coordinator = objc_getAssociatedObject(
      _outsideTapWindow, ZeroCodeSourceTextOutsideTapCoordinatorKey);
  [coordinator removeTarget:self];
  _outsideTapWindow = self.window;
  if (_outsideTapWindow != nil) {
    [ZeroCodeSourceTextOutsideTapCoordinatorForWindow(_outsideTapWindow)
        addTarget:self];
  }
}

- (void)dealloc {
  ZeroCodeSourceTextOutsideTapCoordinator *coordinator = objc_getAssociatedObject(
      _outsideTapWindow, ZeroCodeSourceTextOutsideTapCoordinatorKey);
  [coordinator removeTarget:self];
}

- (void)prepareForRecycle {
  [super prepareForRecycle];
  ZeroCodeSourceTextOutsideTapCoordinator *coordinator = objc_getAssociatedObject(
      _outsideTapWindow, ZeroCodeSourceTextOutsideTapCoordinatorKey);
  [coordinator removeTarget:self];
  _outsideTapWindow = nil;
  _state.reset();
  _appliedState.reset();
  _textView.frame = CGRectZero;
  _textView.textContainer.size = CGSizeMake(0, CGFLOAT_MAX);
  _textView.attributedText = nil;
}

- (void)syncAttributedTextIfNeeded {
  if (!_state) {
    _appliedState.reset();
    return;
  }
  if (_appliedState == _state) {
    return;
  }
  if (_appliedState &&
      _appliedState->getData().attributedString ==
          _state->getData().attributedString) {
    _appliedState = _state;
    return;
  }
  NSMutableAttributedString *text = [RCTNSAttributedStringFromAttributedString(
      _state->getData().attributedString) mutableCopy];
  RCTApplyBaselineOffset(text);
  _appliedState = _state;
  if ([_textView.attributedText isEqualToAttributedString:text]) {
    return;
  }
  const NSRange savedRange = _textView.selectedRange;
  _suppressSelectionChange = YES;
  _textView.attributedText = text;
  if (savedRange.location != NSNotFound && savedRange.length > 0 &&
      NSMaxRange(savedRange) <= text.length) {
    _textView.selectedRange = savedRange;
  }
  _suppressSelectionChange = NO;
}

- (void)layoutSubviews {
  [super layoutSubviews];
  if (!CGRectEqualToRect(_textView.frame, _view.frame)) {
    _textView.frame = _view.frame;
    _textView.textContainer.size =
        CGSizeMake(CGRectGetWidth(_view.frame), CGFLOAT_MAX);
  }
  [self syncAttributedTextIfNeeded];
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<ZeroCodeSourceTextProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<ZeroCodeSourceTextProps const>(props);
  if (oldViewProps.numberOfLines != newViewProps.numberOfLines) {
    _textView.textContainer.maximumNumberOfLines = newViewProps.numberOfLines;
  }
  if (oldViewProps.selectable != newViewProps.selectable)
    _textView.selectable = newViewProps.selectable;
  if (oldViewProps.allowFontScaling != newViewProps.allowFontScaling) {
    _textView.adjustsFontForContentSizeCategory = newViewProps.allowFontScaling;
  }
  if (oldViewProps.ellipsizeMode != newViewProps.ellipsizeMode) {
    switch (newViewProps.ellipsizeMode) {
    case ZeroCodeSourceTextEllipsizeMode::Head:
      _textView.textContainer.lineBreakMode = NSLineBreakByTruncatingHead;
      break;
    case ZeroCodeSourceTextEllipsizeMode::Middle:
      _textView.textContainer.lineBreakMode = NSLineBreakByTruncatingMiddle;
      break;
    case ZeroCodeSourceTextEllipsizeMode::Tail:
      _textView.textContainer.lineBreakMode = NSLineBreakByTruncatingTail;
      break;
    case ZeroCodeSourceTextEllipsizeMode::Clip:
      _textView.textContainer.lineBreakMode = NSLineBreakByClipping;
      break;
    }
  }
  if (oldViewProps.backgroundColor != newViewProps.backgroundColor) {
    _textView.backgroundColor =
        RCTUIColorFromSharedColor(newViewProps.backgroundColor);
  }
  [super updateProps:props oldProps:oldProps];
}

- (void)updateState:(const facebook::react::State::Shared &)state
           oldState:(const facebook::react::State::Shared &)oldState {
  _state =
      std::static_pointer_cast<const ZeroCodeSourceTextShadowNode::ConcreteState>(
          state);
  [self syncAttributedTextIfNeeded];
}

- (void)clearSelectionForOutsideTapWithHitView:(UIView *)hitView {
  if ([hitView isDescendantOfView:self])
    return;
  UITextView *textView = _textView;
  // Allow a pending native Copy action to consume its selection first.
  dispatch_async(dispatch_get_main_queue(), ^{
    UITextRange *range = textView.selectedTextRange;
    if (range != nil && !range.isEmpty)
      textView.selectedTextRange = nil;
  });
}

- (void)textViewDidChangeSelection:(UITextView *)textView {
  if (_suppressSelectionChange || _eventEmitter == nullptr)
    return;
  const NSRange range = textView.selectedRange;
  if (range.location == NSNotFound)
    return;
  std::dynamic_pointer_cast<const facebook::react::ZeroCodeSourceTextEventEmitter>(
      _eventEmitter)
      ->onSelectionChange(
          facebook::react::ZeroCodeSourceTextEventEmitter::OnSelectionChange{
              static_cast<int>(self.tag), static_cast<int>(range.location),
              static_cast<int>(NSMaxRange(range))});
}

Class<RCTComponentViewProtocol> ZeroCodeSourceTextCls(void) {
  return ZeroCodeSourceText.class;
}
@end
