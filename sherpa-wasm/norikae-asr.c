// sherpa-onnx の C API を、このアプリが使う形（ReazonSpeech の transducer を modified_beam_search で）に固定する薄い層。
// 設定の構造体を JS 側で組み立てずに済むので、sherpa-onnx の版が変わっても JS を直さなくてよい。
#include <stdlib.h>
#include <string.h>

#include "sherpa-onnx/c-api/c-api.h"

const SherpaOnnxOfflineRecognizer *norikae_create(const char *encoder, const char *decoder, const char *joiner,
                                                  const char *tokens, const char *hotwords_file, float hotwords_score) {
  SherpaOnnxOfflineRecognizerConfig c;
  memset(&c, 0, sizeof(c));
  c.feat_config.sample_rate = 16000;
  c.feat_config.feature_dim = 80;
  c.model_config.transducer.encoder = encoder;
  c.model_config.transducer.decoder = decoder;
  c.model_config.transducer.joiner = joiner;
  c.model_config.tokens = tokens;
  c.model_config.num_threads = 1;
  c.model_config.provider = "cpu";
  c.model_config.model_type = "transducer";
  c.model_config.modeling_unit = "cjkchar";
  c.decoding_method = "modified_beam_search";
  c.max_active_paths = 4;
  c.hotwords_file = hotwords_file;
  c.hotwords_score = hotwords_score;
  return SherpaOnnxCreateOfflineRecognizer(&c);
}

// 返す文字列は呼び出し側が free する。
char *norikae_recognize(const SherpaOnnxOfflineRecognizer *r, const float *samples, int32_t n) {
  const SherpaOnnxOfflineStream *s = SherpaOnnxCreateOfflineStream(r);
  SherpaOnnxAcceptWaveformOffline(s, 16000, samples, n);
  SherpaOnnxDecodeOfflineStream(r, s);
  const SherpaOnnxOfflineRecognizerResult *res = SherpaOnnxGetOfflineStreamResult(s);
  char *text = strdup(res->text);
  SherpaOnnxDestroyOfflineRecognizerResult(res);
  SherpaOnnxDestroyOfflineStream(s);
  return text;
}
