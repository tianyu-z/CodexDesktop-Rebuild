import { randomUUID } from 'node:crypto';
import { inputText } from './handoff.mjs';
import { presentItem } from './codex-events.mjs';

/** Keep native steering and public history bound to the same managed turn. */
export async function steerManagedTurn(router, params) {
  const chat = router.store.require(params.threadId), active = chat.activeRun;
  if (!active) throw new Error('No active engine turn is running. Send the prompt as a new turn.');
  if (params.expectedTurnId !== active.turnId) throw new Error('Turn ownership mismatch.');
  const text = inputText(params.input);
  if (!text.trim()) throw new Error('Steering requires a nonempty text prompt.');
  const mixed = active.mode === 'both';
  const owner = mixed ? router.workflow.active.get(active.id) : router.runs.get(active.id);
  const handle = mixed ? owner?.handle : owner?.adapterRun;
  if (!owner || typeof handle?.steer !== 'function') throw new Error('The engine is still starting. Retry steering after initialization.');
  const receipt = await handle.steer(text);
  const item = { id: `steering-user:${randomUUID()}`, type: 'userMessage', content: structuredClone(params.input),
    ...(params.clientUserMessageId ? { clientId: params.clientUserMessageId } : {}) };
  // Acceptance can race completion; retain the accepted message in its original
  // turn, never whichever turn happens to be active when the receipt arrives.
  owner.turn.items.push(item);
  const engine = mixed ? 'both' : 'claude';
  router.store.putTurn(chat.id, owner.turn, { engine, runId: active.id });
  for (const method of ['item/started', 'item/completed']) router.notify(method, { threadId: chat.id, turnId: active.turnId, item: presentItem(item, engine) });
  if (receipt?.failures?.length) {
    const notice = { id: `steering-delivery:${randomUUID()}`, type: 'agentMessage', phase: 'commentary',
      text: `Steering saved for subsequent roles. These running roles could not accept it: ${receipt.failures.map(f => `${f.roleId}: ${f.error}`).join('; ')}` };
    owner.turn.items.push(notice); router.store.putTurn(chat.id, owner.turn, { engine, runId: active.id });
    router.notify('item/completed', { threadId: chat.id, turnId: active.turnId, item: presentItem(notice, engine) });
  }
  return { turnId: active.turnId };
}
