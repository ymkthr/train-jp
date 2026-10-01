#!/usr/bin/env bash
# wasm/asr.{js,wasm} を作る。
# Even App の WebView は crossOriginIsolated にならず SharedArrayBuffer が無いので、pthread なし・SIMD ありで作る。
# 使い方: npm run build:wasm -w even-g2-asr   （作業場所は WORK、既定は /tmp/even-g2-asr-build。git と cmake と make が要る）
set -euo pipefail

SHERPA_ONNX_VERSION=v1.13.8
EMSDK_VERSION=4.0.23 # sherpa-onnx の build-wasm-simd-*.sh が動作確認している版
WORK=${WORK:-/tmp/even-g2-asr-build}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE

mkdir -p "$WORK" "$OUT"
[ -d "$WORK/emsdk" ] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$WORK/emsdk"
"$WORK/emsdk/emsdk" install "$EMSDK_VERSION"
"$WORK/emsdk/emsdk" activate "$EMSDK_VERSION"
# shellcheck disable=SC1091
source "$WORK/emsdk/emsdk_env.sh"

[ -d "$WORK/sherpa-onnx" ] ||
  git clone --depth 1 --branch "$SHERPA_ONNX_VERSION" https://github.com/k2-fsa/sherpa-onnx.git "$WORK/sherpa-onnx"

# SHERPA_ONNX_ENABLE_WASM で onnxruntime は単一スレッドの SIMD 版静的ライブラリ（onnxruntime-wasm-static_lib-simd）になる。
# 同梱の wasm/* ターゲットは使わず、ライブラリだけ作って下の emcc で必要な関数だけを書き出す。
export SHERPA_ONNX_IS_USING_BUILD_WASM_SH=ON
emcmake cmake -S "$WORK/sherpa-onnx" -B "$WORK/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS=-msimd128 -DCMAKE_CXX_FLAGS=-msimd128 \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_WASM=ON \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_GPU=OFF \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF
cmake --build "$WORK/build" --target sherpa-onnx-c-api -j"$(nproc)"

# 静的ライブラリは wasm-ld が順序に関係なく解決する。
emcc -O3 -msimd128 "$HERE/asr.c" -I"$WORK/sherpa-onnx" \
  "$WORK"/build/lib/*.a "$WORK"/build/_deps/onnxruntime-src/lib/*.a \
  -o "$OUT/asr.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSherpaModule -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=1920MB -sSTACK_SIZE=10MB \
  -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_FUNCTIONS=_asr_create,_asr_recognize,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAPF32,UTF8ToString,stringToNewUTF8

ls -l "$OUT"/asr.js "$OUT"/asr.wasm
