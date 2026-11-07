/**
 * Runtime polyfills viem needs on Hermes. MUST be imported before anything that touches viem/crypto
 * (so it is the first import in index.js).
 *
 * - crypto.getRandomValues: viem/@noble use it for key generation & nonces; Hermes has no WebCrypto.
 * - Buffer: some encoding paths in viem's dependency tree reach for a global Buffer.
 *
 * - TextDecoder: Hermes on RN 0.81 ships TextEncoder but NOT TextDecoder, and viem needs it to
 *   decode any `string` a contract returns. Without it every such read fails — quietly, as a
 *   per-call failure inside a multicall — which is how token names went missing from the asset
 *   rows. UTF-8 only, on top of the Buffer below; that is the only encoding viem asks for.
 */
import 'react-native-get-random-values';
import {Buffer} from 'buffer';

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

if (typeof global.TextDecoder === 'undefined') {
  class Utf8Decoder {
    readonly encoding = 'utf-8';
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const bytes =
        input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
    }
  }
  (global as unknown as {TextDecoder: unknown}).TextDecoder = Utf8Decoder;
}
