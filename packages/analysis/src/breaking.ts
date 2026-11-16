/**
 * detectBreakingChanges: verified (deterministic) breaking-change findings derived from
 * ChangeFacts. Each finding leads with a plain-language description, followed by technical
 * detail, what might break, a recommendation and file/line evidence.
 */
import type { Evidence, Finding, Severity } from '@gmp/core';
import { parseRouteIdentifier } from './contracts.ts';
import { dedupeFindings, makeFinding } from './findings.ts';
import { signatureParams } from './symbols.ts';
import type { ChangeFacts, EnvVarRef, SchemaOperation, SymbolChange } from './types.ts';

const KIND_WORD: Record<string, string> = {
  function: 'function',
  method: 'method',
  class: 'class',
  interface: 'interface',
  type: 'type',
  const: 'constant',
};

function ev(
  facts: ChangeFacts,
  path: string,
  line: number | undefined,
  snippet?: string,
): Evidence {
  const e: Evidence = { repo: facts.repo, path, source: 'diff' };
  if (line !== undefined && line > 0) e.line = line;
  if (snippet) e.snippet = snippet.length > 300 ? `${snippet.slice(0, 300)}…` : snippet;
  return e;
}

/** Evidence for an env var reference (removed reads carry base-side line numbers). */
function envEv(facts: ChangeFacts, e: EnvVarRef): Evidence {
  return e.side === 'base'
    ? evBase(facts, e.path, e.line, e.name)
    : ev(facts, e.path, e.line, e.name);
}

/** Evidence for removed code: the line number is on the base side of the diff. */
function evBase(
  facts: ChangeFacts,
  path: string,
  line: number | undefined,
  snippet?: string,
): Evidence {
  return { ...ev(facts, path, line, snippet), side: 'base' };
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

interface ParamInfo {
  name: string;
  optional: boolean;
  type: string;
  raw: string;
}

function parseParam(raw: string): ParamInfo | null {
  let p = raw.trim();
  if (!p) return null;
  p = p.replace(/^@\w+(?:\([^)]*\))?\s*/g, ''); // decorators / annotations
  p = p.replace(/^(?:public|private|protected|readonly|final|override)\s+/g, '');
  if (/^(?:self|cls|this)\b(?:\s*:.*)?$/.test(p)) return null;
  if (p === '*' || p === '/') return null;
  const variadic =
    /^(?:\.\.\.|\*{1,2})/.test(p) || /\.\.\.\s*\w+$/.test(p) || /\.\.\.[\w<>[\]]*\s+\w+$/.test(p);
  const hasDefault = /=/.test(p.replace(/=>/g, ''));
  const tsOptional = /^[\w$]+\?\s*:/.test(p);
  const nameMatch = /^(?:\.\.\.|\*{1,2})?([\w$]+)/.exec(p);
  let name = nameMatch?.[1] ?? p;
  let type = '';
  const colon = p.indexOf(':');
  if (colon !== -1)
    type = p
      .slice(colon + 1)
      .replace(/=.*$/, '')
      .trim();
  else {
    // Go / Java style: "name Type" or "Type name"
    const parts = p.replace(/=.*$/, '').trim().split(/\s+/);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1] ?? '';
      const first = parts[0] ?? '';
      if (
        /^[a-z_]/.test(first) &&
        !/^(?:int|long|short|byte|char|boolean|double|float|void|string|bool|error|any|uint\d*|int\d*|float\d*)$/.test(
          first,
        )
      ) {
        name = first;
        type = parts.slice(1).join(' ');
      } else {
        name = last;
        type = parts.slice(0, -1).join(' ');
      }
    }
  }
  return {
    name,
    optional:
      variadic ||
      hasDefault ||
      tsOptional ||
      /\|\s*undefined\b/.test(type) ||
      /\bOptional\[/.test(type),
    type: type.replace(/\s+/g, ''),
    raw: p,
  };
}

function returnType(sig: string): string {
  const close = sig.lastIndexOf(')');
  if (close === -1) return '';
  return sig
    .slice(close + 1)
    .replace(/^\s*(?::|->)\s*/, '')
    .replace(/\s*(?:\{|=>|throws\b.*)$/, '')
    .replace(/\s+/g, '')
    .trim();
}

interface SignatureDelta {
  breaking: boolean;
  severity: Severity;
  reasons: string[];
}

function compareSignatures(
  oldSig: string,
  newSig: string,
  language: string,
): SignatureDelta | null {
  const oldParams = signatureParams(oldSig);
  const newParams = signatureParams(newSig);
  if (!oldParams || !newParams) return null;
  const op = oldParams.map(parseParam).filter((p): p is ParamInfo => p !== null);
  const np = newParams.map(parseParam).filter((p): p is ParamInfo => p !== null);
  const reasons: string[] = [];
  let severity: Severity = 'low';
  const strictArity = ['go', 'java', 'kotlin', 'csharp', 'scala', 'swift', 'rust'].includes(
    language,
  );
  const oldRequired = op.filter((p) => !p.optional).length;
  const newRequired = np.filter((p) => !p.optional).length;
  if (newRequired > oldRequired) {
    const added = np
      .filter((p) => !p.optional && !op.some((o) => o.name === p.name))
      .map((p) => p.name);
    reasons.push(
      `now requires ${newRequired - oldRequired} more input${newRequired - oldRequired > 1 ? 's' : ''}${added.length ? ` (${added.join(', ')})` : ''}`,
    );
    severity = 'high';
  }
  if (np.length < op.length) {
    const removed = op.filter((o) => !np.some((p) => p.name === o.name)).map((p) => p.name);
    reasons.push(
      `no longer accepts ${removed.length ? removed.join(', ') : `${op.length - np.length} parameter(s)`}`,
    );
    severity = strictArity || severity === 'high' ? 'high' : 'medium';
  }
  if (np.length > op.length && newRequired <= oldRequired && strictArity) {
    reasons.push('takes additional parameters (all callers must be updated)');
    severity = 'high';
  }
  // Positional reorder / type changes on parameters present in both.
  const common = Math.min(op.length, np.length);
  for (let i = 0; i < common; i++) {
    const o = op[i] as ParamInfo;
    const n = np[i] as ParamInfo;
    if (o.name !== n.name && np.some((p) => p.name === o.name)) {
      reasons.push('parameter order changed');
      severity = severity === 'high' ? 'high' : 'medium';
      break;
    }
    if (o.type && n.type && o.type !== n.type && o.name === n.name) {
      reasons.push(`parameter "${n.name}" type changed from ${o.type} to ${n.type}`);
      if (severity === 'low') severity = 'medium';
    }
    if (!o.optional && n.optional) continue;
    if (o.optional && !n.optional && o.name === n.name) {
      reasons.push(`parameter "${n.name}" is now required`);
      severity = 'high';
    }
  }
  const or = returnType(oldSig);
  const nr = returnType(newSig);
  if (or && nr && or !== nr) {
    reasons.push(`result type changed from ${or} to ${nr}`);
    if (severity === 'low') severity = 'medium';
  }
  if (reasons.length === 0) return { breaking: false, severity: 'info', reasons };
  return { breaking: true, severity, reasons: [...new Set(reasons)] };
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

function languageOf(facts: ChangeFacts, path: string): string {
  return facts.files.find((f) => f.path === path)?.language ?? 'unknown';
}

function symbolFindings(facts: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  const testPaths = new Set(facts.files.filter((f) => f.isTest).map((f) => f.path));
  const syms = facts.touchedSymbols.filter((s) => !testPaths.has(s.path));
  const removedContainers = new Set(
    syms
      .filter((s) => s.change === 'removed' && (s.kind === 'class' || s.kind === 'interface'))
      .map((s) => `${s.path}|${s.qualifiedName}`),
  );
  const addedElsewhere = (s: SymbolChange) =>
    syms.find(
      (a) =>
        a.change === 'added' &&
        a.path !== s.path &&
        a.qualifiedName === s.qualifiedName &&
        a.kind === s.kind,
    );

  for (const s of syms) {
    if (!s.exported) continue;
    const kindWord = KIND_WORD[s.kind] ?? s.kind;
    const label = `${kindWord} \`${s.qualifiedName}\``;
    if (s.change === 'removed') {
      if (s.parent && removedContainers.has(`${s.path}|${s.parent}`)) continue; // folded into container
      const members =
        s.kind === 'class' || s.kind === 'interface'
          ? syms
              .filter(
                (m) => m.change === 'removed' && m.path === s.path && m.parent === s.qualifiedName,
              )
              .map((m) => m.qualifiedName)
          : [];
      const moved = addedElsewhere(s);
      if (moved) {
        out.push(
          makeFinding({
            ruleId: 'moved_export',
            category: 'breaking_change',
            severity: 'medium',
            title: `Public ${label} moved to another file`,
            description: `The shared ${kindWord} "${s.qualifiedName}" was moved from ${s.path} to ${moved.path}. Code that imports it from the old location will stop working unless the old location still re-exports it.`,
            technicalDetail: `Removed from ${s.path}${s.oldLine ? `:${s.oldLine}` : ''}; added in ${moved.path}${moved.line ? `:${moved.line}` : ''}.`,
            whatMightBreak: `Imports of ${s.qualifiedName} that point at ${s.path}.`,
            recommendation:
              'Keep a re-export at the old path or update every import in the same change.',
            evidence: [
              evBase(facts, s.path, s.oldLine, s.oldSignature),
              ev(facts, moved.path, moved.line, moved.newSignature),
            ],
            identity: [facts.repo, s.path, s.qualifiedName],
          }),
        );
        continue;
      }
      out.push(
        makeFinding({
          ruleId: 'removed_export',
          category: 'breaking_change',
          severity: s.kind === 'method' || s.kind === 'const' ? 'medium' : 'high',
          title: `Public ${label} removed`,
          description: `The shared ${kindWord} "${s.qualifiedName}" was deleted from ${s.path}. Anything else that still uses it will fail to build or will crash when it runs.`,
          technicalDetail: `Removed declaration: ${s.oldSignature ?? s.qualifiedName}${members.length ? `; also removes ${members.length} member(s): ${members.slice(0, 10).join(', ')}` : ''}.`,
          whatMightBreak: `Code in this repository, other services or published packages that imports or calls ${s.qualifiedName}.`,
          recommendation: `Search for usages of ${s.name} before merging. If it is used elsewhere, keep a deprecated version for one release or update all callers together.`,
          affected: members.length ? members : [s.qualifiedName],
          evidence: [evBase(facts, s.path, s.oldLine, s.oldSignature)],
          identity: [facts.repo, s.path, s.qualifiedName],
        }),
      );
    } else if (s.change === 'renamed') {
      out.push(
        makeFinding({
          ruleId: 'renamed_export',
          category: 'breaking_change',
          severity: 'high',
          title: `Public ${kindWord} renamed: ${s.oldName} → ${s.qualifiedName}`,
          description: `The shared ${kindWord} "${s.oldName}" was renamed to "${s.qualifiedName}". Code that still uses the old name will stop working.`,
          technicalDetail: `${s.oldSignature ?? s.oldName} → ${s.newSignature ?? s.qualifiedName}`,
          whatMightBreak: `Every caller or importer of ${s.oldName}.`,
          recommendation: `Update all callers in the same change, or keep "${s.oldName}" as a deprecated alias.`,
          evidence: [
            ev(facts, s.path, s.line, s.newSignature),
            evBase(facts, s.path, s.oldLine, s.oldSignature),
          ],
          identity: [facts.repo, s.path, s.oldName ?? '', s.qualifiedName],
        }),
      );
    } else if (s.change === 'modified' && s.signatureChanged && s.oldSignature && s.newSignature) {
      if (s.kind === 'function' || s.kind === 'method') {
        const delta = compareSignatures(s.oldSignature, s.newSignature, languageOf(facts, s.path));
        if (!delta?.breaking) continue;
        out.push(
          makeFinding({
            ruleId: 'signature_change',
            category: 'breaking_change',
            severity: delta.severity,
            title: `Public ${label} changed how it is called`,
            description: `The shared ${kindWord} "${s.qualifiedName}" ${delta.reasons.join('; ')}. Existing code that calls it the old way may fail or behave differently.`,
            technicalDetail: `Before: ${s.oldSignature}\nAfter:  ${s.newSignature}`,
            whatMightBreak: `Callers of ${s.qualifiedName} that were written for the previous signature.`,
            recommendation:
              'Check every caller is updated in this change; prefer adding optional parameters with defaults over changing required ones.',
            evidence: [ev(facts, s.path, s.line, s.newSignature)],
            identity: [facts.repo, s.path, s.qualifiedName, s.oldSignature, s.newSignature],
          }),
        );
      } else if (s.kind === 'interface' || s.kind === 'type') {
        out.push(
          makeFinding({
            ruleId: 'type_shape_change',
            category: 'breaking_change',
            severity: 'medium',
            title: `Public ${label} changed shape`,
            description: `The shared data shape "${s.qualifiedName}" was changed. Code that creates or reads this shape may no longer match it.`,
            technicalDetail: `Before: ${s.oldSignature}\nAfter:  ${s.newSignature}`,
            whatMightBreak: `Code that implements, constructs or reads ${s.qualifiedName}.`,
            recommendation:
              'Confirm whether fields were removed, renamed or made required, and update dependents in the same release.',
            evidence: [ev(facts, s.path, s.line, s.newSignature)],
            identity: [facts.repo, s.path, s.qualifiedName, s.oldSignature, s.newSignature],
          }),
        );
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

function contractFindings(facts: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  const cc = facts.contractsChanged;
  const providers = cc.filter((c) => c.role === 'provider');

  // HTTP routes
  const routeAdds = providers.filter((c) => c.kind === 'http_route' && c.change === 'added');
  for (const c of providers.filter((x) => x.kind === 'http_route' && x.change === 'removed')) {
    const r = parseRouteIdentifier(c.identifier);
    const samePath = r
      ? routeAdds.find((a) => parseRouteIdentifier(a.identifier)?.path === r.path)
      : undefined;
    if (r && samePath) {
      const nr = parseRouteIdentifier(samePath.identifier);
      out.push(
        makeFinding({
          ruleId: 'route_method_changed',
          category: 'breaking_change',
          severity: 'high',
          title: `API endpoint ${r.path} changed from ${r.method} to ${nr?.method ?? '?'}`,
          description: `The web address ${r.path} now expects a different kind of request (${nr?.method ?? '?'} instead of ${r.method}). Apps, websites or services still sending ${r.method} requests will get errors.`,
          technicalDetail: `${c.identifier} removed; ${samePath.identifier} added.`,
          whatMightBreak: `Front-ends, mobile apps, partner integrations or other services calling ${r.method} ${r.path}.`,
          recommendation:
            'Keep the old method working temporarily or coordinate releasing all callers at the same time.',
          evidence: [
            ev(facts, samePath.path, samePath.line, samePath.identifier),
            evBase(facts, c.path, c.oldLine, c.identifier),
          ],
          identity: [facts.repo, c.identifier, samePath.identifier],
        }),
      );
      continue;
    }
    out.push(
      makeFinding({
        ruleId: 'route_removed',
        category: 'breaking_change',
        severity: 'high',
        title: `API endpoint removed: ${c.identifier}`,
        description: `The web address ${r?.path ?? c.identifier} (${r?.method ?? 'any method'}) is no longer provided. Anything that still calls it will receive "not found" errors.`,
        technicalDetail: `Route definition removed from ${c.path}${c.oldLine ? `:${c.oldLine}` : ''}${c.source ? ` (${c.source})` : ''}.`,
        whatMightBreak:
          'Front-ends, mobile apps, partner integrations or other services calling this endpoint.',
        recommendation:
          'Confirm no clients still use this endpoint (check access logs), or deprecate it before removal.',
        evidence: [evBase(facts, c.path, c.oldLine, c.identifier)],
        identity: [facts.repo, c.identifier],
      }),
    );
  }

  // GraphQL
  for (const c of providers.filter((x) => x.kind === 'graphql')) {
    const isField = c.identifier.includes('.');
    if (c.change === 'removed') {
      out.push(
        makeFinding({
          ruleId: isField ? 'graphql_field_removed' : 'graphql_type_removed',
          category: 'breaking_change',
          severity: 'high',
          title: `GraphQL ${isField ? 'field' : 'type'} removed: ${c.identifier}`,
          description: `The API data ${isField ? 'field' : 'type'} "${c.identifier}" was removed from the GraphQL schema. Apps that ask for it will get errors.`,
          technicalDetail: `Removed from ${c.path}${c.oldLine ? `:${c.oldLine}` : ''}${c.oldSignature ? ` (was ${c.oldSignature})` : ''}.`,
          whatMightBreak: `GraphQL queries or mutations that select ${c.identifier}.`,
          recommendation:
            'Mark it @deprecated first and remove it only after clients have stopped using it.',
          evidence: [evBase(facts, c.path, c.oldLine, c.oldSignature ?? c.identifier)],
          identity: [facts.repo, 'graphql', c.identifier],
        }),
      );
    } else if (
      c.change === 'modified' &&
      isField &&
      c.oldSignature !== undefined &&
      c.newSignature !== undefined
    ) {
      const oldArgs = /^\(([^)]*)\)/.exec(c.oldSignature)?.[1] ?? '';
      const newArgs = /^\(([^)]*)\)/.exec(c.newSignature)?.[1] ?? '';
      const requiredArgs = (s: string) =>
        new Set([...s.matchAll(/(\w+):[^\s,)]*!(?!\s*=)/g)].map((m) => m[1] ?? ''));
      const newRequired = [...requiredArgs(newArgs)].filter((a) => !requiredArgs(oldArgs).has(a));
      const oldType = c.oldSignature.replace(/^\([^)]*\)/, '');
      const newType = c.newSignature.replace(/^\([^)]*\)/, '');
      const nullabilityLoosened = newType === oldType.replace(/!$/, '') && oldType.endsWith('!');
      const reasons: string[] = [];
      if (newRequired.length) reasons.push(`now requires argument(s) ${newRequired.join(', ')}`);
      if (oldType !== newType)
        reasons.push(
          nullabilityLoosened
            ? `may now return empty values (was ${oldType}, now ${newType})`
            : `returns ${newType} instead of ${oldType}`,
        );
      const removedArgs = [...oldArgs.matchAll(/(\w+):/g)]
        .map((m) => m[1] ?? '')
        .filter((a) => !new RegExp(`\\b${a}:`).test(newArgs));
      if (removedArgs.length)
        reasons.push(`no longer accepts argument(s) ${removedArgs.join(', ')}`);
      if (reasons.length === 0) continue;
      out.push(
        makeFinding({
          ruleId: 'graphql_field_changed',
          category: 'breaking_change',
          severity:
            newRequired.length ||
            removedArgs.length ||
            (!nullabilityLoosened && oldType !== newType)
              ? 'high'
              : 'medium',
          title: `GraphQL field changed: ${c.identifier}`,
          description: `The API field "${c.identifier}" ${reasons.join('; ')}. Existing app queries may fail or mis-handle the data.`,
          technicalDetail: `Before: ${c.identifier}${c.oldSignature}\nAfter:  ${c.identifier}${c.newSignature}`,
          whatMightBreak: `Client queries that use ${c.identifier}.`,
          recommendation:
            'Add new arguments as optional and introduce new fields instead of changing existing ones.',
          evidence: [ev(facts, c.path, c.line, c.newSignature)],
          identity: [facts.repo, 'graphql', c.identifier, c.oldSignature, c.newSignature],
        }),
      );
    }
  }

  // Protobuf
  for (const c of providers.filter((x) => x.kind === 'proto')) {
    const sigOld = c.oldSignature ?? '';
    const sigNew = c.newSignature ?? '';
    const isRpc = /returns/.test(sigOld || sigNew);
    const isField = /=\s*\d+/.test(sigOld || sigNew) && !/^=/.test((sigOld || sigNew).trim());
    const isEnumValue = /^=\s*-?\d+$/.test((sigOld || sigNew).trim());
    const what = isRpc
      ? 'service call'
      : isField
        ? 'message field'
        : isEnumValue
          ? 'enum value'
          : sigOld === 'service' || sigNew === 'service'
            ? 'service'
            : 'message type';
    if (c.change === 'removed') {
      out.push(
        makeFinding({
          ruleId: isField
            ? 'proto_field_removed'
            : isRpc
              ? 'proto_rpc_removed'
              : 'proto_definition_removed',
          category: 'breaking_change',
          severity: 'high',
          title: `Protobuf ${what} removed: ${c.identifier}`,
          description: isField
            ? `The data field "${c.identifier}" was removed from a message other services exchange. Older senders/receivers will silently lose this data, and re-using its number later corrupts data.`
            : `The ${what} "${c.identifier}" was removed from the shared service definition. Services that still use it will fail.`,
          technicalDetail: `Removed: ${c.identifier} ${sigOld}`.trim(),
          whatMightBreak: 'Other services or clients generated from this .proto file.',
          recommendation: isField
            ? 'Mark the field number and name as `reserved` and coordinate with consumers before removing.'
            : 'Deprecate first and remove only once no client calls it.',
          evidence: [evBase(facts, c.path, c.oldLine, `${c.identifier} ${sigOld}`.trim())],
          identity: [facts.repo, 'proto', c.identifier],
        }),
      );
    } else if (c.change === 'modified') {
      const numOld = /=\s*(-?\d+)/.exec(sigOld)?.[1];
      const numNew = /=\s*(-?\d+)/.exec(sigNew)?.[1];
      const numberChanged = numOld !== undefined && numNew !== undefined && numOld !== numNew;
      out.push(
        makeFinding({
          ruleId: numberChanged
            ? 'proto_field_number_changed'
            : isRpc
              ? 'proto_rpc_changed'
              : 'proto_field_type_changed',
          category: 'breaking_change',
          severity: numberChanged ? 'critical' : 'high',
          title: numberChanged
            ? `Protobuf ${what} number changed: ${c.identifier}`
            : `Protobuf ${what} changed: ${c.identifier}`,
          description: numberChanged
            ? `The wire number of "${c.identifier}" changed from ${numOld} to ${numNew}. Services built with the old definition will read and write this data incorrectly (data corruption).`
            : `The definition of "${c.identifier}" changed. Services built with the old definition may fail to talk to the new one.`,
          technicalDetail: `Before: ${sigOld}\nAfter:  ${sigNew}`,
          whatMightBreak:
            'Any service or client using generated code from the previous .proto definition.',
          recommendation: numberChanged
            ? 'Never renumber fields; add a new field with a new number and deprecate the old one.'
            : 'Add a new field/rpc instead of changing an existing one, and migrate consumers.',
          evidence: [ev(facts, c.path, c.line, `${c.identifier} ${sigNew}`)],
          identity: [facts.repo, 'proto', c.identifier, sigOld, sigNew],
        }),
      );
    }
  }

  // Queues / topics / events
  for (const c of cc.filter(
    (x) => (x.kind === 'queue_topic' || x.kind === 'event') && x.change === 'removed',
  )) {
    const replacement = cc.find(
      (a) => a.kind === c.kind && a.role === c.role && a.change === 'added' && a.path === c.path,
    );
    const producer = c.role === 'provider';
    out.push(
      makeFinding({
        ruleId: replacement
          ? 'topic_renamed'
          : producer
            ? 'topic_producer_removed'
            : 'topic_consumer_removed',
        category: 'breaking_change',
        severity: replacement ? 'high' : 'medium',
        title: replacement
          ? `Message channel renamed: ${c.identifier} → ${replacement.identifier}`
          : producer
            ? `Stops publishing to "${c.identifier}"`
            : `Stops processing messages from "${c.identifier}"`,
        description: replacement
          ? `This change switches from the message channel "${c.identifier}" to "${replacement.identifier}". Other services still using the old name will stop receiving (or sending) these messages.`
          : producer
            ? `This code no longer sends messages to "${c.identifier}". Services that listen on it will stop receiving these events.`
            : `This code no longer listens to "${c.identifier}". Messages sent there may pile up unprocessed.`,
        technicalDetail: `${c.kind} ${c.role} removed in ${c.path}${c.oldLine ? `:${c.oldLine}` : ''}${c.source ? ` (${c.source})` : ''}.`,
        whatMightBreak: producer
          ? `Consumers subscribed to ${c.identifier}.`
          : `Producers publishing to ${c.identifier}; queue backlog growth.`,
        recommendation:
          'Confirm which services use this channel and roll out producer and consumer changes together.',
        evidence: [
          evBase(facts, c.path, c.oldLine, c.identifier),
          ...(replacement
            ? [ev(facts, replacement.path, replacement.line, replacement.identifier)]
            : []),
        ],
        identity: [facts.repo, c.kind, c.role, c.identifier],
      }),
    );
  }

  // Env vars
  const envRemoved = facts.envVarsRemoved;
  const envAdded = facts.envVarsAdded;
  const usedAdded = new Set<string>();
  for (const e of envRemoved) {
    if (e.role === 'provider') {
      out.push(
        makeFinding({
          ruleId: 'env_var_removed',
          category: 'breaking_change',
          severity: 'medium',
          title: `Configuration setting ${e.name} removed from ${e.path}`,
          description: `The setting "${e.name}" was removed from deployment configuration (${e.path}). If any part of the system still reads it, that part will run without it or fail to start.`,
          technicalDetail: `Environment variable definition removed at ${e.path}:${e.line}.`,
          whatMightBreak: `Services or scripts that read ${e.name}.`,
          recommendation: `Verify nothing reads ${e.name} any more, or keep it until consumers are updated.`,
          evidence: [envEv(facts, e)],
          identity: [facts.repo, 'env', 'provider', e.name, e.path],
        }),
      );
      continue;
    }
    const replacement = envAdded.find(
      (a) => a.role === 'consumer' && a.path === e.path && !usedAdded.has(a.name),
    );
    if (replacement) {
      usedAdded.add(replacement.name);
      out.push(
        makeFinding({
          ruleId: 'env_var_renamed',
          category: 'breaking_change',
          severity: 'high',
          title: `Configuration setting renamed: ${e.name} → ${replacement.name}`,
          description: `The application now reads the setting "${replacement.name}" instead of "${e.name}". Environments that only have "${e.name}" configured will behave incorrectly or fail after deployment.`,
          technicalDetail: `${e.path}: stopped reading ${e.name} (line ${e.line}); reads ${replacement.name} (line ${replacement.line}).`,
          whatMightBreak:
            'Every environment (production, staging, CI) and deployment manifest that sets the old name.',
          recommendation: `Add ${replacement.name} to all environments before deploying, or read both names during a transition period.`,
          evidence: [
            ev(facts, replacement.path, replacement.line, replacement.name),
            envEv(facts, e),
          ],
          identity: [facts.repo, 'env', 'rename', e.name, replacement.name],
        }),
      );
    } else {
      out.push(
        makeFinding({
          ruleId: 'env_var_no_longer_read',
          category: 'breaking_change',
          severity: 'low',
          title: `Configuration setting ${e.name} no longer used in ${e.path}`,
          description: `This code stopped reading the setting "${e.name}". Anyone relying on that setting to change behaviour will find it no longer has an effect here.`,
          technicalDetail: `Read removed at ${e.path}:${e.line}.`,
          whatMightBreak: `Operators or environments that configure ${e.name} expecting it to apply.`,
          recommendation: `Confirm the setting is intentionally unused and remove it from deployment configuration.`,
          evidence: [envEv(facts, e)],
          identity: [facts.repo, 'env', 'consumer', e.name, e.path],
        }),
      );
    }
  }

  // Table definitions removed without a matching schema operation (e.g. entity file deleted)
  const opTables = new Set(facts.schemaOperations.map((o) => o.table));
  for (const c of providers.filter((x) => x.kind === 'db_table' && x.change === 'removed')) {
    if (opTables.has(c.identifier)) continue;
    const file = facts.files.find((f) => f.path === c.path);
    if (file?.isMigration) continue;
    out.push(
      makeFinding({
        ruleId: 'table_definition_removed',
        category: 'breaking_change',
        severity: 'medium',
        title: `Database table definition removed: ${c.identifier}`,
        description: `The code no longer defines the database table "${c.identifier}". Parts of the system that read or write this table may fail, and a follow-up migration may drop its data.`,
        technicalDetail: `Table definition removed from ${c.path}${c.oldLine ? `:${c.oldLine}` : ''}${c.source ? ` (${c.source})` : ''}.`,
        whatMightBreak: `Queries, reports or services that use the ${c.identifier} table.`,
        recommendation: 'Confirm the table is unused and plan data retention before dropping it.',
        evidence: [evBase(facts, c.path, c.oldLine, c.identifier)],
        identity: [facts.repo, 'db_table', c.identifier],
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema operations
// ---------------------------------------------------------------------------

function schemaFindings(facts: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  const target = (o: SchemaOperation) => (o.column ? `${o.table}.${o.column}` : o.table);
  for (const o of facts.schemaOperations) {
    const e = [ev(facts, o.path, o.line, o.statement)];
    const id = [facts.repo, o.op, o.table, o.column ?? '', o.newName ?? ''];
    switch (o.op) {
      case 'drop_table':
        out.push(
          makeFinding({
            ruleId: 'schema_drop_table',
            category: 'breaking_change',
            severity: 'critical',
            title: `Database table deleted: ${o.table}`,
            description: `This change permanently deletes the database table "${o.table}" and all data in it. Anything still reading or writing it will fail, and the data cannot be recovered without a backup.`,
            technicalDetail: `${o.source}: ${o.statement}`,
            whatMightBreak: `Every feature, report, job or service that uses the ${o.table} table.`,
            recommendation:
              'Confirm a backup exists, that nothing uses the table, and that the deletion is intended; consider renaming/archiving first.',
            evidence: e,
            identity: id,
          }),
        );
        break;
      case 'drop_column':
        out.push(
          makeFinding({
            ruleId: 'schema_drop_column',
            category: 'breaking_change',
            severity: 'high',
            title: `Database column deleted: ${target(o)}`,
            description: `The column "${o.column}" is removed from the "${o.table}" table, deleting its data. Code (including the version currently running during deployment) that reads or writes it will fail.`,
            technicalDetail: `${o.source}: ${o.statement}`,
            whatMightBreak: `Queries, services and reports that use ${target(o)}; the old app version during a rolling deploy.`,
            recommendation:
              'First ship code that stops using the column, then drop it in a later release (expand/contract).',
            evidence: e,
            identity: id,
          }),
        );
        break;
      case 'truncate_table':
        out.push(
          makeFinding({
            ruleId: 'schema_truncate_table',
            category: 'breaking_change',
            severity: 'critical',
            title: `All rows deleted from table ${o.table}`,
            description: `This migration empties the "${o.table}" table. All existing data in it will be lost.`,
            technicalDetail: `${o.source}: ${o.statement}`,
            whatMightBreak: `All features relying on data in ${o.table}.`,
            recommendation: 'Confirm this is intentional and that a backup exists.',
            evidence: e,
            identity: id,
          }),
        );
        break;
      case 'rename_table':
      case 'rename_column':
        out.push(
          makeFinding({
            ruleId: o.op === 'rename_table' ? 'schema_rename_table' : 'schema_rename_column',
            category: 'breaking_change',
            severity: 'high',
            title: `Database ${o.op === 'rename_table' ? 'table' : 'column'} renamed: ${target(o)} → ${o.newName}`,
            description: `The database ${o.op === 'rename_table' ? 'table' : 'column'} "${target(o)}" is renamed to "${o.newName}". Code using the old name — including the currently running version during deployment and other services sharing the database — will fail.`,
            technicalDetail: `${o.source}: ${o.statement}`,
            whatMightBreak: `Queries and services that reference ${target(o)}.`,
            recommendation:
              'Use an expand/contract migration: add the new name, copy data, switch code, then remove the old name later.',
            evidence: e,
            identity: id,
          }),
        );
        break;
      case 'add_column':
        if (o.notNull && !o.hasDefault) {
          out.push(
            makeFinding({
              ruleId: 'schema_add_required_column',
              category: 'breaking_change',
              severity: 'high',
              title: `Required database column added without a default: ${target(o)}`,
              description: `A new mandatory column "${o.column}" is added to "${o.table}" without a default value. The migration can fail on a table that already has rows, and existing code that saves records without this value will be rejected.`,
              technicalDetail: `${o.source}: ${o.statement}`,
              whatMightBreak: `The deployment migration on non-empty tables; inserts into ${o.table} from code that does not set ${o.column}.`,
              recommendation:
                'Add the column as nullable (or with a default), backfill data, then make it required in a later migration.',
              evidence: e,
              identity: id,
            }),
          );
        }
        break;
      case 'set_not_null':
        out.push(
          makeFinding({
            ruleId: 'schema_set_not_null',
            category: 'breaking_change',
            severity: 'high',
            title: `Database column made mandatory: ${target(o)}`,
            description: `The column "${target(o)}" becomes mandatory. If any existing rows have no value the migration fails, and code that saves records without it will be rejected.`,
            technicalDetail: `${o.source}: ${o.statement}`,
            whatMightBreak: `The migration on existing data; writers of ${o.table} that leave ${o.column} empty.`,
            recommendation: 'Backfill empty values first and confirm all writers set the column.',
            evidence: e,
            identity: id,
          }),
        );
        break;
      case 'alter_column_type':
        out.push(
          makeFinding({
            ruleId: 'schema_alter_column_type',
            category: 'breaking_change',
            severity: 'medium',
            title: `Database column type changed: ${target(o)}`,
            description: `The kind of data stored in "${target(o)}" changes. Existing values may fail to convert, large tables may be locked during the change, and code expecting the old type may misbehave.`,
            technicalDetail: `${o.source}: ${o.statement}`,
            whatMightBreak: `The migration on large or incompatible data; code and reports that read ${target(o)}.`,
            recommendation:
              'Test the migration on a copy of production data and check table-lock impact.',
            evidence: e,
            identity: id,
          }),
        );
        break;
      default:
        break;
    }
  }
  // Editing an already-applied migration
  for (const f of facts.files) {
    if (!f.isMigration || f.status !== 'modified' || f.deletions === 0) continue;
    out.push(
      makeFinding({
        ruleId: 'migration_edited',
        category: 'breaking_change',
        severity: 'medium',
        title: `Existing database migration edited: ${f.path}`,
        description:
          'A migration file that may already have run in some environments was changed. Environments that already applied it will not pick up the edit, so databases can drift apart.',
        technicalDetail: `${f.deletions} line(s) removed/changed in an existing migration.`,
        whatMightBreak: 'Consistency between production, staging and developer databases.',
        recommendation:
          'Leave applied migrations untouched and add a new migration for the change.',
        evidence: [evBase(facts, f.path, f.hunks[0]?.oldStart)],
        identity: [facts.repo, 'migration_edited', f.path],
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auth / access control
// ---------------------------------------------------------------------------

function authFindings(facts: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  const byPath = new Map<string, typeof facts.permissionChanges>();
  for (const p of facts.permissionChanges) byPath.set(p.path, [...(byPath.get(p.path) ?? []), p]);
  for (const [path, list] of byPath) {
    const removedAuth = list.filter((p) => p.kind === 'auth_middleware' && p.change === 'removed');
    const addedAuth = list.filter((p) => p.kind === 'auth_middleware' && p.change === 'added');
    for (const p of list.filter((x) => x.kind === 'access_control' && x.change === 'added')) {
      out.push(
        makeFinding({
          ruleId: 'auth_bypass_added',
          category: 'security',
          severity: 'high',
          title: `Access check relaxed in ${path}`,
          description:
            'This change adds code that lets requests skip a login, permission or CSRF check. Parts of the application may become reachable without the usual protection.',
          technicalDetail: p.detail,
          whatMightBreak:
            'Data or actions that were previously restricted may become accessible to anyone.',
          recommendation:
            'Have a security-aware reviewer confirm the exemption is intended and limited to the right endpoints.',
          evidence: [ev(facts, path, p.line, p.detail)],
          identity: [facts.repo, 'auth_bypass_added', path, p.detail],
        }),
      );
    }
    if (removedAuth.length > 0 && addedAuth.length < removedAuth.length) {
      const first = removedAuth[0];
      out.push(
        makeFinding({
          ruleId: 'auth_check_removed',
          category: 'security',
          severity: 'high',
          title: `Authentication/authorization check removed in ${path}`,
          description:
            'A login or permission check was removed and not replaced in the same file. Endpoints or actions that used it may now be open to users who should not have access.',
          technicalDetail: removedAuth.map((r) => `- ${r.detail} (line ${r.line})`).join('\n'),
          whatMightBreak: 'Access control for the affected routes or handlers.',
          recommendation:
            'Confirm the protection moved elsewhere (e.g. router-level middleware) or restore it.',
          evidence: removedAuth.slice(0, 5).map((r) => evBase(facts, path, r.line, r.detail)),
          identity: [facts.repo, 'auth_check_removed', path, ...(first ? [first.detail] : [])],
        }),
      );
    }
    const file = facts.files.find((f) => f.path === path);
    const routesAddedHere = facts.contractsChanged.some(
      (c) => c.path === path && c.kind === 'http_route' && c.change === 'added',
    );
    if (addedAuth.length > removedAuth.length && file?.status === 'modified' && !routesAddedHere) {
      out.push(
        makeFinding({
          ruleId: 'auth_requirement_added',
          category: 'breaking_change',
          severity: 'low',
          title: `Access rules tightened in ${path}`,
          description:
            'A login or permission check was added to existing functionality. Callers that do not send the required credentials or lack the permission will now be rejected.',
          technicalDetail: addedAuth.map((r) => `+ ${r.detail} (line ${r.line})`).join('\n'),
          whatMightBreak:
            'Integrations, scripts or users that previously accessed this without credentials/permission.',
          recommendation:
            'Confirm all legitimate callers already authenticate with sufficient permissions.',
          evidence: addedAuth.slice(0, 5).map((r) => ev(facts, path, r.line, r.detail)),
          identity: [facts.repo, 'auth_requirement_added', path],
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

function dependencyFindings(facts: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  for (const d of facts.dependencyChanges) {
    if (d.change === 'upgraded' && d.major) {
      out.push(
        makeFinding({
          ruleId: 'dependency_major_upgrade',
          category: 'breaking_change',
          severity: d.dev ? 'low' : 'medium',
          title: `Major version upgrade: ${d.name} ${d.from} → ${d.to}`,
          description: `The ${d.dev ? 'development tool' : 'library'} "${d.name}" moves to a new major version, which by convention may include incompatible changes${d.dev ? ' to the build or test setup' : ' in how the application behaves'}.`,
          technicalDetail: `${d.manifest}: ${d.name} ${d.from} → ${d.to} (${d.ecosystem})`,
          whatMightBreak: d.dev
            ? 'Builds, linting or tests.'
            : `Code that uses ${d.name}; behaviour at runtime.`,
          recommendation: `Read the ${d.name} release notes / migration guide and make sure tests cover the affected code.`,
          evidence: [ev(facts, d.manifest, d.line, `${d.name}: ${d.from} → ${d.to}`)],
          identity: [facts.repo, 'dep_major', d.manifest, d.name, d.to ?? ''],
        }),
      );
    } else if (d.change === 'removed' && !d.dev) {
      out.push(
        makeFinding({
          ruleId: 'dependency_removed',
          category: 'breaking_change',
          severity: 'low',
          title: `Dependency removed: ${d.name}`,
          description: `The library "${d.name}" was removed. Any code that still uses it will fail to build or start.`,
          technicalDetail: `${d.manifest}: removed ${d.name} ${d.from ?? ''}`.trim(),
          whatMightBreak: `Code importing ${d.name}.`,
          recommendation: `Confirm nothing imports ${d.name} any more.`,
          evidence: [ev(facts, d.manifest, d.line, d.name)],
          identity: [facts.repo, 'dep_removed', d.manifest, d.name],
        }),
      );
    }
  }
  return out;
}

/**
 * Detects breaking changes from ChangeFacts. All findings are deterministic facts
 * (`verified: true`, `source: 'rule'`) with evidence; results are deduplicated and sorted.
 */
export function detectBreakingChanges(facts: ChangeFacts): Finding[] {
  return dedupeFindings([
    ...symbolFindings(facts),
    ...contractFindings(facts),
    ...schemaFindings(facts),
    ...authFindings(facts),
    ...dependencyFindings(facts),
  ]);
}

export const __internal = { compareSignatures, parseParam };
