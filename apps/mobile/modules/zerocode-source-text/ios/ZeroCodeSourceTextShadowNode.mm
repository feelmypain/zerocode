#include "ZeroCodeSourceTextShadowNode.h"
#include "ZeroCodeSourceTextRunShadowNode.h"
#include <react/renderer/components/view/ViewShadowNode.h>
#import <react/renderer/textlayoutmanager/RCTAttributedTextUtils.h>

#include <algorithm>
#include <cmath>
#include <functional>

namespace facebook::react {

namespace {
size_t hashCombine(size_t seed, size_t value) {
  return seed ^ (value + 0x9e3779b97f4a7c15ULL + (seed << 6) + (seed >> 2));
}
} // namespace

ZeroCodeSourceTextShadowNode::ZeroCodeSourceTextShadowNode(
    const ShadowNode &sourceShadowNode, const ShadowNodeFragment &fragment)
    : ConcreteViewShadowNode(sourceShadowNode, fragment) {
  if (fragment.props == ShadowNodeFragment::propsPlaceholder() &&
      fragment.children == ShadowNodeFragment::childrenPlaceholder()) {
    const auto &source =
        static_cast<const ZeroCodeSourceTextShadowNode &>(sourceShadowNode);
    std::lock_guard lock(source._cacheMutex);
    _attributedString = source._attributedString;
    _cacheKey = source._cacheKey;
    _measurementCache = source._measurementCache;
    _measurementCacheNextSlot = source._measurementCacheNextSlot;
  }
}

Size ZeroCodeSourceTextShadowNode::measureContent(
    const LayoutContext &layoutContext,
    const LayoutConstraints &layoutConstraints) const {
  const auto &baseProps = getConcreteProps();

  Float fontSizeMultiplier = 1.0;
  if (baseProps.allowFontScaling) {
    fontSizeMultiplier = layoutContext.fontSizeMultiplier;
  }

  const auto &children = getChildren();
  size_t childrenHash = children.size();
  for (size_t i = 0; i < children.size(); i++) {
    const auto child = children[i].get();
    childrenHash = hashCombine(
        childrenHash, std::hash<const void *>{}(child->getProps().get()));
  }

  const ContentCacheKey nextKey{
      .basePropsPtr = getProps().get(),
      .childCount = children.size(),
      .childrenHash = childrenHash,
      .fontSizeMultiplier = fontSizeMultiplier,
      .valid = true,
  };

  const CGFloat maximumWidth =
      std::isfinite(layoutConstraints.maximumSize.width)
          ? layoutConstraints.maximumSize.width
          : CGFLOAT_MAX;
  const double maximumWidthKey = static_cast<double>(maximumWidth);

  AttributedString attributedString;
  bool needsBuildAttributedString = false;
  {
    std::lock_guard lock(_cacheMutex);
    if (_cacheKey == nextKey) {
      for (const auto &entry : _measurementCache) {
        if (entry.valid && entry.maximumWidth == maximumWidthKey) {
          return {
              std::clamp(entry.measuredWidth,
                         layoutConstraints.minimumSize.width,
                         layoutConstraints.maximumSize.width),
              std::clamp(entry.measuredHeight,
                         layoutConstraints.minimumSize.height,
                         layoutConstraints.maximumSize.height),
          };
        }
      }
      attributedString = _attributedString;
    } else {
      needsBuildAttributedString = true;
    }
  }

  if (needsBuildAttributedString) {
    auto baseAttributedString = AttributedString{};
    for (size_t i = 0; i < children.size(); i++) {
      const auto child = children[i].get();
      if (auto textViewChild =
              dynamic_cast<const ZeroCodeSourceTextRunShadowNode *>(child)) {
        auto &props = textViewChild->getConcreteProps();
        auto fragment = AttributedString::Fragment{};
        auto textAttributes = TextAttributes::defaultTextAttributes();

        textAttributes.allowFontScaling = baseProps.allowFontScaling;
        textAttributes.backgroundColor = props.backgroundColor;
        textAttributes.fontSize = props.fontSize * fontSizeMultiplier;
        textAttributes.lineHeight = props.lineHeight * fontSizeMultiplier;
        textAttributes.foregroundColor = props.color;
        textAttributes.textShadowColor = props.shadowColor;
        textAttributes.textShadowOffset = props.shadowOffset;
        textAttributes.textShadowRadius = props.shadowRadius;
        textAttributes.letterSpacing = props.letterSpacing;
        textAttributes.textDecorationColor = props.textDecorationColor;
        textAttributes.fontFamily = props.fontFamily;

        if (props.fontStyle == ZeroCodeSourceTextRunFontStyle::Italic) {
          textAttributes.fontStyle = FontStyle::Italic;
        } else {
          textAttributes.fontStyle = FontStyle::Normal;
        }

        if (props.fontWeight == ZeroCodeSourceTextRunFontWeight::Bold) {
          textAttributes.fontWeight = FontWeight::Bold;
        } else if (props.fontWeight == ZeroCodeSourceTextRunFontWeight::UltraLight) {
          textAttributes.fontWeight = FontWeight::UltraLight;
        } else if (props.fontWeight == ZeroCodeSourceTextRunFontWeight::Light) {
          textAttributes.fontWeight = FontWeight::Light;
        } else if (props.fontWeight == ZeroCodeSourceTextRunFontWeight::Medium) {
          textAttributes.fontWeight = FontWeight::Medium;
        } else if (props.fontWeight == ZeroCodeSourceTextRunFontWeight::Semibold) {
          textAttributes.fontWeight = FontWeight::Semibold;
        } else if (props.fontWeight == ZeroCodeSourceTextRunFontWeight::Heavy) {
          textAttributes.fontWeight = FontWeight::Heavy;
        } else {
          textAttributes.fontWeight = FontWeight::Regular;
        }

        if (props.textDecorationLine ==
            ZeroCodeSourceTextRunTextDecorationLine::LineThrough) {
          textAttributes.textDecorationLineType =
              TextDecorationLineType::Strikethrough;
        } else if (props.textDecorationLine ==
                   ZeroCodeSourceTextRunTextDecorationLine::Underline) {
          textAttributes.textDecorationLineType =
              TextDecorationLineType::Underline;
        } else {
          textAttributes.textDecorationLineType = TextDecorationLineType::None;
        }

        if (props.textDecorationStyle ==
            ZeroCodeSourceTextRunTextDecorationStyle::Solid) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Solid;
        } else if (props.textDecorationStyle ==
                   ZeroCodeSourceTextRunTextDecorationStyle::Dotted) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Dotted;
        } else if (props.textDecorationStyle ==
                   ZeroCodeSourceTextRunTextDecorationStyle::Dashed) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Dashed;
        } else if (props.textDecorationStyle ==
                   ZeroCodeSourceTextRunTextDecorationStyle::Double) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Double;
        }

        if (props.textAlign == ZeroCodeSourceTextRunTextAlign::Left) {
          textAttributes.alignment = TextAlignment::Left;
        } else if (props.textAlign == ZeroCodeSourceTextRunTextAlign::Right) {
          textAttributes.alignment = TextAlignment::Right;
        } else if (props.textAlign == ZeroCodeSourceTextRunTextAlign::Center) {
          textAttributes.alignment = TextAlignment::Center;
        } else if (props.textAlign == ZeroCodeSourceTextRunTextAlign::Justify) {
          textAttributes.alignment = TextAlignment::Justified;
        } else if (props.textAlign == ZeroCodeSourceTextRunTextAlign::Auto) {
          textAttributes.alignment = TextAlignment::Natural;
        }

        textAttributes.backgroundColor = props.backgroundColor;

        fragment.string = props.text;
        fragment.textAttributes = textAttributes;

        baseAttributedString.appendFragment(std::move(fragment));
      }
    }
    attributedString = std::move(baseAttributedString);
  }

  NSMutableAttributedString *convertedAttributedString =
      [RCTNSAttributedStringFromAttributedString(attributedString)
          mutableCopy];
  // Match React Native's baseline offset in both measurement and rendering.
  RCTApplyBaselineOffset(convertedAttributedString);

  NSTextStorage *textStorage = [[NSTextStorage alloc]
      initWithAttributedString:convertedAttributedString];
  NSLayoutManager *layoutManager = [[NSLayoutManager alloc] init];
  layoutManager.usesFontLeading = NO;
  NSTextContainer *textContainer = [[NSTextContainer alloc]
      initWithSize:CGSizeMake(maximumWidth, CGFLOAT_MAX)];
  textContainer.lineFragmentPadding = 0;
  textContainer.maximumNumberOfLines = baseProps.numberOfLines;
  if (baseProps.ellipsizeMode == ZeroCodeSourceTextEllipsizeMode::Head) {
    textContainer.lineBreakMode = NSLineBreakByTruncatingHead;
  } else if (baseProps.ellipsizeMode == ZeroCodeSourceTextEllipsizeMode::Middle) {
    textContainer.lineBreakMode = NSLineBreakByTruncatingMiddle;
  } else if (baseProps.ellipsizeMode == ZeroCodeSourceTextEllipsizeMode::Tail) {
    textContainer.lineBreakMode = NSLineBreakByTruncatingTail;
  } else {
    textContainer.lineBreakMode = NSLineBreakByClipping;
  }
  [layoutManager addTextContainer:textContainer];
  [textStorage addLayoutManager:layoutManager];
  [layoutManager ensureLayoutForTextContainer:textContainer];
  const CGRect usedRect =
      [layoutManager usedRectForTextContainer:textContainer];

  const Float measuredWidth = static_cast<Float>(std::ceil(usedRect.size.width));
  const Float measuredHeight = static_cast<Float>(std::ceil(usedRect.size.height));

  {
    std::lock_guard lock(_cacheMutex);
    if (!(_cacheKey == nextKey)) {
      _attributedString = std::move(attributedString);
      _cacheKey = nextKey;
      _measurementCache = {};
      _measurementCacheNextSlot = 0;
    }
    _measurementCache[_measurementCacheNextSlot] = MeasurementCacheEntry{
        .maximumWidth = maximumWidthKey,
        .measuredWidth = measuredWidth,
        .measuredHeight = measuredHeight,
        .valid = true,
    };
    _measurementCacheNextSlot =
        (_measurementCacheNextSlot + 1) % kMeasurementCacheCapacity;
  }

  return {
      std::clamp(measuredWidth,
                 layoutConstraints.minimumSize.width,
                 layoutConstraints.maximumSize.width),
      std::clamp(measuredHeight,
                 layoutConstraints.minimumSize.height,
                 layoutConstraints.maximumSize.height),
  };
}

void ZeroCodeSourceTextShadowNode::layout(LayoutContext layoutContext) {
  ensureUnsealed();
  AttributedString attributedString;
  {
    std::lock_guard lock(_cacheMutex);
    attributedString = _attributedString;
  }
  setStateData(ZeroCodeSourceTextStateReal{
      std::move(attributedString),
  });
}
} // namespace facebook::react
