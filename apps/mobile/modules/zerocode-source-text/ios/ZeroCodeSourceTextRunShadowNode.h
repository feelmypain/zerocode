#pragma once

#include <react/renderer/components/ZeroCodeSourceTextSpec/EventEmitters.h>
#include <react/renderer/components/ZeroCodeSourceTextSpec/Props.h>
#include <react/renderer/components/ZeroCodeSourceTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char ZeroCodeSourceTextRunComponentName[];

using ZeroCodeSourceTextRunShadowNode =
    ConcreteViewShadowNode<ZeroCodeSourceTextRunComponentName, ZeroCodeSourceTextRunProps,
                           ZeroCodeSourceTextRunEventEmitter, ZeroCodeSourceTextRunState>;
} // namespace facebook::react
