/**
 * Runtime polyfills viem needs on Hermes. MUST be imported before anything that touches viem/crypto
 * (so it is the first import in index.js).
 *
 * - crypto.getRandomValues: viem/@noble use it for key generation & nonces; Hermes has no WebCrypto.
 * - Buffer: some encoding paths in viem's dependency tree reach for a global Buffer.
 *
 * TextEncoder/TextDecoder are provided by Hermes on RN 0.81, so they are not polyfilled here. If a
 * bundle error points at them on an older engine, add `text-encoding` and assign the globals below.
 */
import 'react-native-get-random-values';
import {Buffer} from 'buffer';

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}
