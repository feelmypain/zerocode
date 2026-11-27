#pragma once

#include "HybridZeroCodeHighlightsSpec.hpp"

namespace margelo::nitro::zerocodehighlights {

class HybridZeroCodeHighlights : public HybridZeroCodeHighlightsSpec {
public:
  HybridZeroCodeHighlights() : HybridObject(TAG) {}

  std::optional<std::shared_ptr<ArrayBuffer>> tokenize(SourceText source,
                                                       double language) override;
  std::shared_ptr<Promise<std::optional<std::shared_ptr<ArrayBuffer>>>> tokenizeAsync(
      SourceText source, double language) override;
};

} // namespace margelo::nitro::zerocodehighlights
