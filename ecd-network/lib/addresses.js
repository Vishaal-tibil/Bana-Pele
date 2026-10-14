// Where each part of a node lives, by run mode. Used by tools/configure.js
// (to write adapter configs and registry records) and by the apps (to call
// their own adapter and the registry), so the two can never disagree.
//
// mode "local" : every process on 127.0.0.1, ports from the node file
// mode "docker": compose service names; adapters listen on 8080 inside

'use strict';

// secret: the node's webhook path secret (see webhookSecret in kit.js). Only
// the node's own adapter knows it, so nothing else can post fake Beckn
// messages into the app.
function addresses(node, network, mode = process.env.ECD_MODE || 'local', secret = '') {
  const hook = `/beckn/hook${secret ? `-${secret}` : ''}`;
  const side = node.role === 'BAP' ? 'bap' : 'bpp';
  if (mode === 'docker') {
    return {
      mode, side,
      adapterPort: 8080,
      receiver: `http://onix-${node.id}:8080/${side}/receiver`,
      caller: `http://onix-${node.id}:8080/${side}/caller`,
      webhook: `http://${node.id}-app:${node.ports.app}${hook}`,
      redis: `redis-${node.id}:6379`,
      registry: 'http://ecd-registry:3030',
    };
  }
  return {
    mode, side,
    adapterPort: node.ports.onix,
    receiver: `http://127.0.0.1:${node.ports.onix}/${side}/receiver`,
    caller: `http://127.0.0.1:${node.ports.onix}/${side}/caller`,
    webhook: `http://127.0.0.1:${node.ports.app}${hook}`,
    redis: `127.0.0.1:${node.ports.redis}`,
    registry: `http://127.0.0.1:${network.registryPort}`,
  };
}

module.exports = { addresses };
