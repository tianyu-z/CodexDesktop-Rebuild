/** Explicit references are data labels, never interpolation or property expressions. */
export function renderInputs(references, resolve) {
  return references.map(reference => {
    const value = resolve(reference);
    if (value === undefined) throw new Error(`Unavailable input reference: ${reference}`);
    const label = reference === 'request' ? 'Original user request' : reference === 'history' ? 'Public conversation history' : 'Referenced public result';
    return `## ${label}: ${reference}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`;
  }).join('\n\n');
}
