/** Frontend ownership has gateway-specific history and edit semantics. Native
 * app-server ownership is deliberately shared and is not changed here. */
function createThreadIpcScope({ broadcastVersion, requestVersion }) {
  const clients = new WeakMap(), prefix = 'cdx-dev-thread-v1/';
  const scopedRequest = method => method === 'thread-owner-discovery' || method.startsWith('thread-follower-');
  const scopedBroadcast = method => method.startsWith('thread-stream-') || method === 'thread-queued-followups-changed';
  const wireMethod = (method, version) => `${prefix}${version}/${method}`;
  return function wrap(client) {
    if (clients.has(client)) return clients.get(client);
    const adapter = {
      waitUntilInitialized(...args) { return client.waitUntilInitialized(...args); },
      async sendRequest(method, params, options) {
        if (!scopedRequest(method)) return client.sendRequest(method, params, options);
        const wire = wireMethod(method, requestVersion(method, params));
        const response = await client.sendRequest(wire, params, options);
        if (response.resultType !== 'success') return response;
        if (response.method !== wire) throw Error('thread-follower-response-method-mismatch');
        return { ...response, method };
      },
      addRequestHandler(method, predicate, handler) {
        if (!scopedRequest(method)) return client.addRequestHandler(method, predicate, handler);
        const versions = new Set([requestVersion(method)]);
        // Upstream accepts both old unscoped interrupts and turn-scoped ones.
        if (method === 'thread-follower-interrupt-turn') versions.add(requestVersion(method, {}));
        const remove = [...versions].map(version => client.addRequestHandler(wireMethod(method, version), predicate,
          envelope => handler({ ...envelope, method, version })));
        return () => { for (const dispose of remove) dispose(); };
      },
      sendBroadcast(method, params, options) {
        return client.sendBroadcast(scopedBroadcast(method) ? wireMethod(method, broadcastVersion(method)) : method, params, options);
      },
      addAnyBroadcastHandler(handler) {
        return client.addAnyBroadcastHandler(envelope => {
          const { method } = envelope;
          if (scopedBroadcast(method)) return; // Foreign frontend history/cursors.
          if (!method.startsWith(prefix)) return handler(envelope);
          const match = method.slice(prefix.length).match(/^(\d+)\/(.+)$/);
          if (!match || (envelope.version ?? 0) !== 0) return;
          const original = match[2], version = Number(match[1]);
          if (!scopedBroadcast(original) || broadcastVersion(original) !== version) return;
          return handler({ ...envelope, method: original, version });
        });
      },
    };
    clients.set(client, adapter); clients.set(adapter, adapter);
    return adapter;
  };
}
module.exports = { createThreadIpcScope };
