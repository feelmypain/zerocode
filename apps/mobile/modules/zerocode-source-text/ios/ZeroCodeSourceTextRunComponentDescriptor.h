#pragma once

#include "ZeroCodeSourceTextRunShadowNode.h"

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {
using ZeroCodeSourceTextRunComponentDescriptor =
    ConcreteComponentDescriptor<ZeroCodeSourceTextRunShadowNode>;

void ZeroCodeSourceTextRunSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
} // namespace facebook::react
