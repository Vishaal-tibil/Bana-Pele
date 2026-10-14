// Test helper: signs a body the way a Beckn adapter does, so the tests can
// send hand-made messages straight to an adapter's receiver -- valid ones
// (to prove the format matches ONIX) and forged ones (to prove they are refused).
//
// Signing string: "(created): <c>\n(expires): <e>\ndigest: BLAKE-512=<base64 blake2b-512(body)>"
// Header: Signature keyId="<subscriber>|<key_id>|ed25519",algorithm="ed25519",
//         created="<c>",expires="<e>",headers="(created) (expires) digest",signature="<base64>"

'use strict';
const crypto = require('crypto');

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function privateKeyFromRaw(privB64, pubB64) {
  return crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: b64url(Buffer.from(privB64, 'base64')), x: b64url(Buffer.from(pubB64, 'base64')) },
    format: 'jwk',
  });
}

function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    priv: Buffer.from(jwk.d, 'base64url').toString('base64'),
    pub: Buffer.from(jwk.x, 'base64url').toString('base64'),
  };
}

function authHeader(bodyText, { subscriberId, keyId, priv, pub, created, expires }) {
  const c = created || Math.floor(Date.now() / 1000);
  const e = expires || c + 300;
  const digest = crypto.createHash('blake2b512').update(bodyText).digest('base64');
  const signing = `(created): ${c}\n(expires): ${e}\ndigest: BLAKE-512=${digest}`;
  const sig = crypto.sign(null, Buffer.from(signing), privateKeyFromRaw(priv, pub)).toString('base64');
  return `Signature keyId="${subscriberId}|${keyId}|ed25519",algorithm="ed25519",created="${c}",expires="${e}",headers="(created) (expires) digest",signature="${sig}"`;
}

module.exports = { authHeader, newKeyPair };
