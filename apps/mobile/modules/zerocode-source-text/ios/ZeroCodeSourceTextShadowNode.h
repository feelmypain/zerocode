#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <mutex>

#include <react/renderer/components/ZeroCodeSourceTextSpec/EventEmitters.h>
#include <react/renderer/components/ZeroCodeSourceTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>

namespace facebook::react {

extern const char ZeroCodeSourceTextComponentName[];

class ZeroCodeSourceTextStateReal final {
public:
  AttributedString attributedString;
};

class ZeroCodeSourceTextShadowNode final
    : public ConcreteViewShadowNode<ZeroCodeSourceTextComponentName,
                                    ZeroCodeSourceTextProps, ZeroCodeSourceTextEventEmitter,
                                    ZeroCodeSourceTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  ZeroCodeSourceTextShadowNode(const ShadowNode &sourceShadowNode,
                         const ShadowNodeFragment &fragment);

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size
  measureContent(const LayoutContext &layoutContext,
                 const LayoutConstraints &layoutConstraints) const override;

private:
  struct ContentCacheKey {
    const void *basePropsPtr{nullptr};
    size_t childCount{0};
    size_t childrenHash{0};
    Float fontSizeMultiplier{0};
    bool valid{false};

    bool operator==(const ContentCacheKey &other) const = default;
  };

  struct MeasurementCacheEntry {
    double maximumWidth{0};
    Float measuredWidth{0};
    Float measuredHeight{0};
    bool valid{false};
  };

  static constexpr size_t kMeasurementCacheCapacity = 4;

  mutable std::mutex _cacheMutex;
  mutable AttributedString _attributedString;
  mutable ContentCacheKey _cacheKey;
  mutable std::array<MeasurementCacheEntry, kMeasurementCacheCapacity>
      _measurementCache{};
  mutable size_t _measurementCacheNextSlot{0};
};
} // namespace facebook::react
