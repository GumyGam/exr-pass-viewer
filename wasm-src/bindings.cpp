// Embind bindings for tinyexr.
//
// Exposes a single `TinyExr` class to JS that wraps the multipart-capable
// tinyexr C API. Single-part EXRs (the common Cycles output) are handled by
// promoting them to a 1-part multipart structure internally so callers always
// see a uniform "channels have a partIndex" surface.
//
// API surface (see ../README and src/wasm/tinyexr.ts):
//   loadFromBuffer(Uint8Array)          -> bool
//   getDimensions()                     -> { width, height }
//   getChannels()                       -> [{ name, pixelType, partIndex }]
//   getChannelData(channelName)         -> Float32Array
//   getAttributes()                     -> [{ name, type, bytes }]
//   free()                              -> void
//
// Channel naming: tinyexr leaves channel names in their original hierarchical
// form (e.g. "ViewLayer.CryptoMaterial02.r"). We surface that verbatim. For
// multipart files we prefix with the part name ("<part>/<channel>") if the
// part has a non-empty name and we have >1 part.

#define TINYEXR_IMPLEMENTATION
#define TINYEXR_USE_MINIZ 1
#include "tinyexr/tinyexr.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

using emscripten::val;

namespace {

struct ChannelLocator {
  int part_index;
  int channel_index;
};

class TinyExr {
 public:
  TinyExr() = default;

  ~TinyExr() { release(); }

  // Parse EXR from in-memory buffer. Accepts a JS Uint8Array.
  bool loadFromBuffer(val uint8) {
    release();

    // Copy bytes out of JS into our owned buffer. We retain the bytes for the
    // lifetime of this instance because tinyexr does not require it but
    // copying once is simpler than juggling external lifetimes from JS.
    const unsigned int length = uint8["length"].as<unsigned int>();
    file_bytes_.resize(length);
    if (length > 0) {
      val memory_view = val(emscripten::typed_memory_view(length, file_bytes_.data()));
      memory_view.call<void>("set", uint8);
    }

    const unsigned char* mem = file_bytes_.data();
    const size_t size = file_bytes_.size();

    EXRVersion version;
    int ret = ParseEXRVersionFromMemory(&version, mem, size);
    if (ret != TINYEXR_SUCCESS) {
      throw std::runtime_error(std::string("ParseEXRVersionFromMemory failed: ") +
                               std::to_string(ret));
    }

    if (version.multipart) {
      // Multi-part path.
      EXRHeader** headers = nullptr;
      int num_headers = 0;
      const char* err = nullptr;
      ret = ParseEXRMultipartHeaderFromMemory(&headers, &num_headers, &version,
                                              mem, size, &err);
      if (ret != TINYEXR_SUCCESS) {
        std::string msg = "ParseEXRMultipartHeaderFromMemory failed: ";
        msg += (err ? err : "(no message)");
        if (err) FreeEXRErrorMessage(err);
        throw std::runtime_error(msg);
      }

      // Take ownership.
      headers_.assign(headers, headers + num_headers);
      // tinyexr allocates the EXRHeader* array with malloc; we keep the
      // outer array pointer so we can free it on release.
      headers_outer_ = headers;

      images_.resize(num_headers);
      for (int i = 0; i < num_headers; ++i) {
        InitEXRImage(&images_[i]);
      }

      // Promote HALF -> FLOAT so the JS surface is uniformly float32.
      for (EXRHeader* h : headers_) {
        for (int c = 0; c < h->num_channels; ++c) {
          if (h->pixel_types[c] == TINYEXR_PIXELTYPE_HALF) {
            h->requested_pixel_types[c] = TINYEXR_PIXELTYPE_FLOAT;
          }
        }
      }

      std::vector<const EXRHeader*> const_headers(headers_.begin(), headers_.end());
      ret = LoadEXRMultipartImageFromMemory(images_.data(), const_headers.data(),
                                            static_cast<unsigned int>(num_headers),
                                            mem, size, &err);
      if (ret != TINYEXR_SUCCESS) {
        std::string msg = "LoadEXRMultipartImageFromMemory failed: ";
        msg += (err ? err : "(no message)");
        if (err) FreeEXRErrorMessage(err);
        release();
        throw std::runtime_error(msg);
      }
    } else {
      // Single-part path: parse header + load directly, then store as a
      // 1-part multipart-style view.
      EXRHeader* header = new EXRHeader();
      InitEXRHeader(header);

      const char* err = nullptr;
      ret = ParseEXRHeaderFromMemory(header, &version, mem, size, &err);
      if (ret != TINYEXR_SUCCESS) {
        std::string msg = "ParseEXRHeaderFromMemory failed: ";
        msg += (err ? err : "(no message)");
        if (err) FreeEXRErrorMessage(err);
        FreeEXRHeader(header);
        delete header;
        throw std::runtime_error(msg);
      }

      // Request FLOAT pixel type for HALF channels so callers always get
      // float32 data. UINT channels remain UINT.
      for (int c = 0; c < header->num_channels; ++c) {
        if (header->pixel_types[c] == TINYEXR_PIXELTYPE_HALF) {
          header->requested_pixel_types[c] = TINYEXR_PIXELTYPE_FLOAT;
        }
      }

      EXRImage image;
      InitEXRImage(&image);
      ret = LoadEXRImageFromMemory(&image, header, mem, size, &err);
      if (ret != TINYEXR_SUCCESS) {
        std::string msg = "LoadEXRImageFromMemory failed: ";
        msg += (err ? err : "(no message)");
        if (err) FreeEXRErrorMessage(err);
        FreeEXRHeader(header);
        delete header;
        throw std::runtime_error(msg);
      }

      headers_.push_back(header);
      headers_outer_ = nullptr;  // we own each header via `new`/`delete` for the single-part path
      single_part_owns_headers_ = true;
      images_.push_back(image);
    }

    width_ = images_[0].width;
    height_ = images_[0].height;

    // Build channel name index.
    channel_index_.clear();
    channel_locators_.clear();
    const bool multi = headers_.size() > 1;
    for (size_t p = 0; p < headers_.size(); ++p) {
      const EXRHeader* h = headers_[p];
      for (int c = 0; c < h->num_channels; ++c) {
        std::string name = h->channels[c].name;
        if (multi && h->name[0] != '\0') {
          name = std::string(h->name) + "/" + name;
        }
        ChannelLocator loc{static_cast<int>(p), c};
        channel_index_[name] = loc;
        channel_locators_.push_back({name, loc});
      }
    }

    loaded_ = true;
    return true;
  }

  val getDimensions() const {
    requireLoaded();
    val out = val::object();
    out.set("width", width_);
    out.set("height", height_);
    return out;
  }

  val getChannels() const {
    requireLoaded();
    val arr = val::array();
    int idx = 0;
    for (const auto& entry : channel_locators_) {
      const EXRHeader* h = headers_[entry.loc.part_index];
      val o = val::object();
      o.set("name", entry.name);
      o.set("pixelType", h->pixel_types[entry.loc.channel_index]);
      o.set("partIndex", entry.loc.part_index);
      arr.set(idx++, o);
    }
    return arr;
  }

  val getChannelData(const std::string& channelName) const {
    requireLoaded();
    auto it = channel_index_.find(channelName);
    if (it == channel_index_.end()) {
      throw std::runtime_error("channel not found: " + channelName);
    }
    const ChannelLocator& loc = it->second;
    const EXRHeader* h = headers_[loc.part_index];
    const EXRImage& img = images_[loc.part_index];

    const int pt = h->pixel_types[loc.channel_index];
    const size_t pixels = static_cast<size_t>(img.width) * static_cast<size_t>(img.height);

    // Build a Float32Array view backed by HEAPF32 and copy data in.
    val Float32Array = val::global("Float32Array");
    val js_array = Float32Array.new_(static_cast<unsigned>(pixels));

    if (pt == TINYEXR_PIXELTYPE_FLOAT) {
      const float* src = reinterpret_cast<const float*>(img.images[loc.channel_index]);
      val view = val(emscripten::typed_memory_view(pixels, src));
      js_array.call<void>("set", view);
    } else if (pt == TINYEXR_PIXELTYPE_UINT) {
      // Coerce uint32 channels (e.g. object id) to float32 so the JS surface
      // is uniform. Precision loss above 2^24 is acceptable for IDs that fit
      // in 24 bits; callers needing exact ints can read raw attributes.
      const uint32_t* src = reinterpret_cast<const uint32_t*>(img.images[loc.channel_index]);
      std::vector<float> tmp(pixels);
      for (size_t i = 0; i < pixels; ++i) tmp[i] = static_cast<float>(src[i]);
      val view = val(emscripten::typed_memory_view(pixels, tmp.data()));
      js_array.call<void>("set", view);
    } else {
      // HALF would only appear if we didn't promote it. For single-part we
      // requested FLOAT for all HALF channels; for multipart the library
      // already returns float32 for FLOAT/HALF when default-loading. If we
      // ever hit raw HALF here, surface it instead of silently breaking.
      throw std::runtime_error(
          "unsupported pixel type for channel " + channelName +
          " (pt=" + std::to_string(pt) + ")");
    }

    return js_array;
  }

  val getAttributes() const {
    requireLoaded();
    val arr = val::array();
    int idx = 0;
    // Aggregate custom attributes across all parts. For single-part, all
    // cryptomatte/* attrs live on the one header. For multi-part, we surface
    // each part's custom attrs with no prefix; callers can disambiguate via
    // the (less common) multipart cryptomatte layout if needed.
    for (size_t p = 0; p < headers_.size(); ++p) {
      const EXRHeader* h = headers_[p];
      for (int a = 0; a < h->num_custom_attributes; ++a) {
        const EXRAttribute& attr = h->custom_attributes[a];
        val o = val::object();
        o.set("name", std::string(attr.name));
        o.set("type", std::string(attr.type));
        val Uint8Array = val::global("Uint8Array");
        val js_bytes = Uint8Array.new_(static_cast<unsigned>(attr.size));
        if (attr.size > 0 && attr.value != nullptr) {
          val view = val(emscripten::typed_memory_view(
              static_cast<size_t>(attr.size),
              reinterpret_cast<const uint8_t*>(attr.value)));
          js_bytes.call<void>("set", view);
        }
        o.set("bytes", js_bytes);
        o.set("partIndex", static_cast<int>(p));
        arr.set(idx++, o);
      }
    }
    return arr;
  }

  void free_() { release(); }

 private:
  void requireLoaded() const {
    if (!loaded_) throw std::runtime_error("TinyExr: no file loaded");
  }

  void release() {
    for (size_t i = 0; i < images_.size(); ++i) {
      FreeEXRImage(&images_[i]);
    }
    images_.clear();

    // Free each EXRHeader's internals + the struct itself.
    // - single-part path: we own each EXRHeader via `new` -> `delete`
    // - multipart path: tinyexr allocates each EXRHeader via `malloc` -> free
    for (EXRHeader* h : headers_) {
      if (!h) continue;
      FreeEXRHeader(h);
      if (single_part_owns_headers_) {
        delete h;
      } else {
        std::free(h);
      }
    }
    headers_.clear();

    if (headers_outer_) {
      // tinyexr allocates the outer EXRHeader** array via malloc().
      std::free(headers_outer_);
      headers_outer_ = nullptr;
    }

    single_part_owns_headers_ = false;
    channel_index_.clear();
    channel_locators_.clear();
    file_bytes_.clear();
    width_ = 0;
    height_ = 0;
    loaded_ = false;
  }

  struct NamedLocator {
    std::string name;
    ChannelLocator loc;
  };

  bool loaded_ = false;
  int width_ = 0;
  int height_ = 0;
  std::vector<EXRHeader*> headers_;
  EXRHeader** headers_outer_ = nullptr;  // for multipart: outer array pointer
  bool single_part_owns_headers_ = false;
  std::vector<EXRImage> images_;
  std::unordered_map<std::string, ChannelLocator> channel_index_;
  std::vector<NamedLocator> channel_locators_;
  std::vector<unsigned char> file_bytes_;
};

}  // namespace

EMSCRIPTEN_BINDINGS(tinyexr_module) {
  emscripten::class_<TinyExr>("TinyExr")
      .constructor<>()
      .function("loadFromBuffer", &TinyExr::loadFromBuffer)
      .function("getDimensions", &TinyExr::getDimensions)
      .function("getChannels", &TinyExr::getChannels)
      .function("getChannelData", &TinyExr::getChannelData)
      .function("getAttributes", &TinyExr::getAttributes)
      .function("free", &TinyExr::free_);
}
