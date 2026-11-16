/**
 * Database schema operations from migrations (SQL, Rails, Django, Alembic, Knex, Sequelize,
 * TypeORM, Laravel, Liquibase) and column-level diffs of ORM schema files (Prisma, Drizzle,
 * Django models).
 */
import { normalizeTableName } from './contracts.ts';
import { detectLanguage } from './language.ts';
import type { SchemaOperation, SchemaOperationType } from './types.ts';

const MAX_STATEMENT = 240;

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_STATEMENT ? `${t.slice(0, MAX_STATEMENT)}…` : t;
}

function ident(raw: string | undefined): string {
  return (raw ?? '')
    .replace(/[`"[\]']/g, '')
    .replace(/^:/, '')
    .trim();
}

function table(raw: string | undefined): string {
  return normalizeTableName(raw ?? '') ?? ident(raw).toLowerCase();
}

/** Splits on commas that are not inside parentheses or quotes. */
function splitTopLevel(text: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

interface Ctx {
  path: string;
  ops: SchemaOperation[];
}

function push(
  ctx: Ctx,
  op: SchemaOperationType,
  tableName: string,
  line: number,
  statement: string,
  source: string,
  extra: Partial<SchemaOperation> = {},
): void {
  if (!tableName && op !== 'drop_index') return;
  ctx.ops.push({
    op,
    table: tableName,
    path: ctx.path,
    line,
    statement: clip(statement),
    source,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const T = String.raw`((?:[\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\])(?:\.(?:[\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]))?)`;
const C = String.raw`([\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\])`;

function sqlStatement(ctx: Ctx, stmt: string, line: number): void {
  const s = stmt
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return;
  let m: RegExpExecArray | null;
  if (
    (m = new RegExp(
      String.raw`^CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${T}`,
      'i',
    ).exec(s))
  ) {
    push(ctx, 'create_table', table(m[1]), line, s, 'sql');
    return;
  }
  if ((m = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(.+?)(?:\s+(?:CASCADE|RESTRICT))?$/i.exec(s))) {
    for (const t of splitTopLevel(m[1] ?? '')) push(ctx, 'drop_table', table(t), line, s, 'sql');
    return;
  }
  if ((m = /^RENAME\s+TABLE\s+(.+)$/i.exec(s))) {
    for (const pair of splitTopLevel(m[1] ?? '')) {
      const pm = /^(\S+)\s+TO\s+(\S+)$/i.exec(pair);
      if (pm) push(ctx, 'rename_table', table(pm[1]), line, s, 'sql', { newName: table(pm[2]) });
    }
    return;
  }
  if ((m = new RegExp(String.raw`^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?${T}`, 'i').exec(s))) {
    push(ctx, 'truncate_table', table(m[1]), line, s, 'sql');
    return;
  }
  if (
    (m = new RegExp(
      String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:${C}\s+)?ON\s+(?:ONLY\s+)?${T}`,
      'i',
    ).exec(s))
  ) {
    push(ctx, 'create_index', table(m[3]), line, s, 'sql', {
      column: ident(m[2]),
      hasDefault: !!m[1],
    });
    return;
  }
  if (
    (m = new RegExp(
      String.raw`^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?${T}(?:\s+ON\s+${T})?`,
      'i',
    ).exec(s))
  ) {
    push(ctx, 'drop_index', m[2] ? table(m[2]) : '', line, s, 'sql', { column: ident(m[1]) });
    return;
  }
  m = new RegExp(
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${T}\s+(.*)$`,
    'i',
  ).exec(s);
  if (!m) return;
  const tbl = table(m[1]);
  for (const action of splitTopLevel(m[2] ?? '')) {
    let a: RegExpExecArray | null;
    if ((a = /^RENAME\s+TO\s+(\S+)/i.exec(action)))
      push(ctx, 'rename_table', tbl, line, s, 'sql', { newName: table(a[1]) });
    else if (
      (a = new RegExp(String.raw`^RENAME\s+(?:COLUMN\s+)?${C}\s+TO\s+${C}`, 'i').exec(action))
    )
      push(ctx, 'rename_column', tbl, line, s, 'sql', {
        column: ident(a[1]),
        newName: ident(a[2]),
      });
    else if (
      /^ADD\s+(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|INDEX|KEY)\b/i.test(action)
    )
      push(ctx, 'add_constraint', tbl, line, s, 'sql');
    else if (
      (a = new RegExp(
        String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${C}\s*(.*)$`,
        'i',
      ).exec(action))
    ) {
      const rest = a[2] ?? '';
      push(ctx, 'add_column', tbl, line, s, 'sql', {
        column: ident(a[1]),
        notNull: /\bNOT\s+NULL\b/i.test(rest) || /\bPRIMARY\s+KEY\b/i.test(rest),
        hasDefault: /\bDEFAULT\b|\bGENERATED\b|\bSERIAL\b|\bAUTO_INCREMENT\b|\bIDENTITY\b/i.test(
          rest,
        ),
      });
    } else if ((a = /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\S+)/i.exec(action)))
      push(ctx, 'drop_constraint', tbl, line, s, 'sql', { column: ident(a[1]) });
    else if (/^DROP\s+(?:PRIMARY\s+KEY|FOREIGN\s+KEY|INDEX|KEY)\b/i.test(action))
      push(ctx, 'drop_constraint', tbl, line, s, 'sql');
    else if (
      (a = new RegExp(String.raw`^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?${C}`, 'i').exec(action))
    )
      push(ctx, 'drop_column', tbl, line, s, 'sql', { column: ident(a[1]) });
    else if ((a = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?${C}\s+(.*)$`, 'i').exec(action))) {
      const col = ident(a[1]);
      const rest = a[2] ?? '';
      if (/^(?:SET\s+DATA\s+)?TYPE\b/i.test(rest))
        push(ctx, 'alter_column_type', tbl, line, s, 'sql', { column: col });
      else if (/^SET\s+NOT\s+NULL/i.test(rest))
        push(ctx, 'set_not_null', tbl, line, s, 'sql', { column: col });
      else if (/^DROP\s+NOT\s+NULL/i.test(rest))
        push(ctx, 'drop_not_null', tbl, line, s, 'sql', { column: col });
    } else if (
      (a = new RegExp(String.raw`^MODIFY\s+(?:COLUMN\s+)?${C}\s+(.*)$`, 'i').exec(action))
    ) {
      const col = ident(a[1]);
      push(ctx, 'alter_column_type', tbl, line, s, 'sql', { column: col });
      if (/\bNOT\s+NULL\b/i.test(a[2] ?? ''))
        push(ctx, 'set_not_null', tbl, line, s, 'sql', { column: col });
    } else if (
      (a = new RegExp(String.raw`^CHANGE\s+(?:COLUMN\s+)?${C}\s+${C}\s+(.*)$`, 'i').exec(action))
    ) {
      const from = ident(a[1]);
      const to = ident(a[2]);
      if (from.toLowerCase() !== to.toLowerCase())
        push(ctx, 'rename_column', tbl, line, s, 'sql', { column: from, newName: to });
      push(ctx, 'alter_column_type', tbl, line, s, 'sql', { column: to });
    }
  }
}

/** Splits SQL text into statements (by `;` outside quotes) with their starting line. */
function sqlStatements(text: string, lineMap: number[]): Array<{ stmt: string; line: number }> {
  const out: Array<{ stmt: string; line: number }> = [];
  const lines = text.split('\n');
  let cur = '';
  let start = -1;
  let quote: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i] ?? '';
    if (!quote) l = l.replace(/--.*$/, '');
    for (const ch of l) {
      if (start === -1 && ch.trim()) start = i;
      if (quote) {
        if (ch === quote) quote = null;
        cur += ch;
        continue;
      }
      if (ch === "'") quote = ch;
      if (ch === ';') {
        if (cur.trim()) out.push({ stmt: cur, line: lineMap[start] ?? start + 1 });
        cur = '';
        start = -1;
        continue;
      }
      cur += ch;
    }
    cur += '\n';
  }
  if (cur.trim() && start !== -1) out.push({ stmt: cur, line: lineMap[start] ?? start + 1 });
  return out;
}

// ---------------------------------------------------------------------------
// Code migrations (ORM / framework DSLs)
// ---------------------------------------------------------------------------

function kwarg(args: string, name: string): string | undefined {
  const m = new RegExp(String.raw`\b${name}\s*=\s*['"]([^'"]+)['"]`).exec(args);
  return m?.[1];
}

/** Collects call text starting at line i until parentheses balance (max 40 lines). */
function callText(lines: string[], i: number, start: number): string {
  let depth = 0;
  let out = '';
  let begun = false;
  for (let k = i; k < lines.length && k < i + 40; k++) {
    const l = k === i ? (lines[k] ?? '').slice(start) : (lines[k] ?? '');
    for (const ch of l) {
      out += ch;
      if (ch === '(') {
        depth++;
        begun = true;
      } else if (ch === ')') {
        depth--;
        if (begun && depth === 0) return out;
      }
    }
    out += '\n';
  }
  return out;
}

function codeMigration(ctx: Ctx, text: string, lineMap: number[], lang: string): void {
  const lines = text.split('\n');
  let contextTable = ''; // knex alterTable / rails change_table / laravel Schema::table
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const l = raw.trim();
    const line = lineMap[i] ?? i + 1;
    if (!l || l.startsWith('#') || l.startsWith('//')) continue;
    let m: RegExpExecArray | null;

    // Raw SQL in strings (op.execute, queryRunner.query, knex.raw, DB::statement, execute "...")
    for (const lit of l.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const sql = lit[2] ?? '';
      if (/^\s*(?:CREATE|ALTER|DROP|RENAME|TRUNCATE)\s+(?:TABLE|INDEX|UNIQUE)/i.test(sql)) {
        for (const st of sqlStatements(sql, [line])) sqlStatement(ctx, st.stmt, line);
      }
    }

    // ---- Rails ----
    if (lang === 'ruby') {
      if (
        (m = /^change_table\s+:?['"]?(\w+)/.exec(l)) ||
        (m = /^create_table\s+:?['"]?(\w+)/.exec(l))
      ) {
        if (l.startsWith('create_table')) push(ctx, 'create_table', table(m[1]), line, l, 'rails');
        contextTable = l.startsWith('change_table') ? table(m[1]) : '';
        continue;
      }
      if ((m = /^drop_table\s+:?['"]?(\w+)/.exec(l)))
        push(ctx, 'drop_table', table(m[1]), line, l, 'rails');
      else if ((m = /^rename_table\s+:?['"]?(\w+)['"]?\s*,\s*:?['"]?(\w+)/.exec(l)))
        push(ctx, 'rename_table', table(m[1]), line, l, 'rails', { newName: table(m[2]) });
      else if ((m = /^remove_column\s+:?['"]?(\w+)['"]?\s*,\s*:?['"]?(\w+)/.exec(l)))
        push(ctx, 'drop_column', table(m[1]), line, l, 'rails', { column: m[2] ?? '' });
      else if ((m = /^remove_columns\s+:?['"]?(\w+)['"]?\s*,\s*(.*)$/.exec(l))) {
        for (const c of (m[2] ?? '').matchAll(/:(\w+)/g))
          push(ctx, 'drop_column', table(m[1]), line, l, 'rails', { column: c[1] ?? '' });
      } else if (
        (m = /^rename_column\s+:?['"]?(\w+)['"]?\s*,\s*:?['"]?(\w+)['"]?\s*,\s*:?['"]?(\w+)/.exec(
          l,
        ))
      )
        push(ctx, 'rename_column', table(m[1]), line, l, 'rails', {
          column: m[2] ?? '',
          newName: m[3] ?? '',
        });
      else if ((m = /^add_column\s+:?['"]?(\w+)['"]?\s*,\s*:?['"]?(\w+)['"]?(.*)$/.exec(l)))
        push(ctx, 'add_column', table(m[1]), line, l, 'rails', {
          column: m[2] ?? '',
          notNull: /null:\s*false/.test(m[3] ?? ''),
          hasDefault: /default:/.test(m[3] ?? ''),
        });
      else if (
        (m =
          /^change_column_null\s+:?['"]?(\w+)['"]?\s*,\s*:?['"]?(\w+)['"]?\s*,\s*(true|false)/.exec(
            l,
          ))
      )
        push(
          ctx,
          m[3] === 'false' ? 'set_not_null' : 'drop_not_null',
          table(m[1]),
          line,
          l,
          'rails',
          { column: m[2] ?? '' },
        );
      else if ((m = /^change_column\s+:?['"]?(\w+)['"]?\s*,\s*:?['"]?(\w+)/.exec(l)))
        push(ctx, 'alter_column_type', table(m[1]), line, l, 'rails', { column: m[2] ?? '' });
      else if ((m = /^add_index\s+:?['"]?(\w+)/.exec(l)))
        push(ctx, 'create_index', table(m[1]), line, l, 'rails', {
          hasDefault: /algorithm:\s*:concurrently/.test(l),
        });
      else if ((m = /^remove_index\s+:?['"]?(\w+)/.exec(l)))
        push(ctx, 'drop_index', table(m[1]), line, l, 'rails');
      else if (contextTable && (m = /^t\.remove\s+(.*)$/.exec(l))) {
        for (const c of (m[1] ?? '').matchAll(/:(\w+)/g))
          push(ctx, 'drop_column', contextTable, line, l, 'rails', { column: c[1] ?? '' });
      } else if (contextTable && (m = /^t\.rename\s+:(\w+)\s*,\s*:(\w+)/.exec(l)))
        push(ctx, 'rename_column', contextTable, line, l, 'rails', {
          column: m[1] ?? '',
          newName: m[2] ?? '',
        });
      else if (/^end\b/.test(l) && indentOf(raw) <= 4) contextTable = '';
      continue;
    }

    // ---- Django ----
    if (
      (m =
        /\bmigrations\.(RemoveField|DeleteModel|RenameField|RenameModel|AddField|AlterField|CreateModel)\(/.exec(
          l,
        ))
    ) {
      const args = callText(lines, i, m.index);
      const model = (kwarg(args, 'model_name') ?? '').toLowerCase();
      switch (m[1]) {
        case 'RemoveField':
          push(ctx, 'drop_column', model, line, args, 'django', {
            column: kwarg(args, 'name') ?? '',
          });
          break;
        case 'DeleteModel':
          push(ctx, 'drop_table', (kwarg(args, 'name') ?? '').toLowerCase(), line, args, 'django');
          break;
        case 'RenameField':
          push(ctx, 'rename_column', model, line, args, 'django', {
            column: kwarg(args, 'old_name') ?? '',
            newName: kwarg(args, 'new_name') ?? '',
          });
          break;
        case 'RenameModel':
          push(
            ctx,
            'rename_table',
            (kwarg(args, 'old_name') ?? '').toLowerCase(),
            line,
            args,
            'django',
            { newName: (kwarg(args, 'new_name') ?? '').toLowerCase() },
          );
          break;
        case 'CreateModel':
          push(
            ctx,
            'create_table',
            (kwarg(args, 'name') ?? '').toLowerCase(),
            line,
            args,
            'django',
          );
          break;
        case 'AddField':
          push(ctx, 'add_column', model, line, args, 'django', {
            column: kwarg(args, 'name') ?? '',
            notNull: !/\bnull\s*=\s*True\b/.test(args) && !/ManyToManyField/.test(args),
            hasDefault: /\bdefault\s*=/.test(args) || /\bauto_now(?:_add)?\s*=\s*True/.test(args),
          });
          break;
        case 'AlterField':
          push(ctx, 'alter_column_type', model, line, args, 'django', {
            column: kwarg(args, 'name') ?? '',
          });
          break;
      }
      continue;
    }

    // ---- Alembic ----
    if (
      (m =
        /\bop\.(drop_table|drop_column|rename_table|alter_column|add_column|create_table|create_index|drop_index|drop_constraint)\(/.exec(
          l,
        ))
    ) {
      const args = callText(lines, i, m.index);
      const strs = [...args.matchAll(/['"]([\w.]+)['"]/g)].map((x) => x[1] ?? '');
      switch (m[1]) {
        case 'drop_table':
          push(ctx, 'drop_table', table(strs[0]), line, args, 'alembic');
          break;
        case 'create_table':
          push(ctx, 'create_table', table(strs[0]), line, args, 'alembic');
          break;
        case 'drop_column':
          push(ctx, 'drop_column', table(strs[0]), line, args, 'alembic', {
            column: strs[1] ?? '',
          });
          break;
        case 'rename_table':
          push(ctx, 'rename_table', table(strs[0]), line, args, 'alembic', {
            newName: table(strs[1]),
          });
          break;
        case 'add_column':
          push(ctx, 'add_column', table(strs[0]), line, args, 'alembic', {
            column: strs[1] ?? '',
            notNull: /nullable\s*=\s*False/.test(args),
            hasDefault: /server_default\s*=/.test(args),
          });
          break;
        case 'alter_column': {
          const t = table(strs[0]);
          const col = strs[1] ?? '';
          const nn = kwarg(args, 'new_column_name');
          if (nn)
            push(ctx, 'rename_column', t, line, args, 'alembic', { column: col, newName: nn });
          if (/nullable\s*=\s*False/.test(args))
            push(ctx, 'set_not_null', t, line, args, 'alembic', { column: col });
          if (/nullable\s*=\s*True/.test(args))
            push(ctx, 'drop_not_null', t, line, args, 'alembic', { column: col });
          if (/\btype_\s*=/.test(args))
            push(ctx, 'alter_column_type', t, line, args, 'alembic', { column: col });
          break;
        }
        case 'create_index':
          push(ctx, 'create_index', table(strs[1]), line, args, 'alembic', {
            column: strs[0] ?? '',
            hasDefault: /postgresql_concurrently\s*=\s*True/.test(args),
          });
          break;
        case 'drop_index':
          push(ctx, 'drop_index', table(strs[1] ?? ''), line, args, 'alembic', {
            column: strs[0] ?? '',
          });
          break;
        case 'drop_constraint':
          push(ctx, 'drop_constraint', table(strs[1]), line, args, 'alembic', {
            column: strs[0] ?? '',
          });
          break;
      }
      continue;
    }

    // ---- Knex / Sequelize / TypeORM / Laravel ----
    if (
      (m = /\.(?:alterTable|table)\(\s*['"`](\w+)['"`]/.exec(l)) ||
      (m = /Schema::table\(\s*['"](\w+)['"]/.exec(l))
    ) {
      contextTable = table(m[1]);
    }
    if (
      (m = /\.createTable(?:IfNotExists)?\(\s*['"`](\w+)['"`]/.exec(l)) ||
      (m = /Schema::create\(\s*['"](\w+)['"]/.exec(l))
    ) {
      push(ctx, 'create_table', table(m[1]), line, l, 'migration');
      contextTable = '';
      continue;
    }
    if (
      (m = /\.dropTable(?:IfExists)?\(\s*['"`](\w+)['"`]/.exec(l)) ||
      (m = /Schema::drop(?:IfExists)?\(\s*['"](\w+)['"]/.exec(l))
    ) {
      push(ctx, 'drop_table', table(m[1]), line, l, 'migration');
      continue;
    }
    if (
      (m = /\.renameTable\(\s*['"`](\w+)['"`]\s*,\s*['"`](\w+)['"`]/.exec(l)) ||
      (m = /Schema::rename\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]/.exec(l))
    ) {
      push(ctx, 'rename_table', table(m[1]), line, l, 'migration', { newName: table(m[2]) });
      continue;
    }
    if ((m = /\.(?:removeColumn|dropColumn)\(\s*['"`](\w+)['"`]\s*,\s*['"`](\w+)['"`]/.exec(l))) {
      push(ctx, 'drop_column', table(m[1]), line, l, 'migration', { column: m[2] ?? '' });
      continue;
    }
    if (
      (m = /\.renameColumn\(\s*['"`](\w+)['"`]\s*,\s*['"`](\w+)['"`]\s*,\s*['"`](\w+)['"`]/.exec(l))
    ) {
      push(ctx, 'rename_column', table(m[1]), line, l, 'migration', {
        column: m[2] ?? '',
        newName: m[3] ?? '',
      });
      continue;
    }
    if ((m = /\.addColumn\(\s*['"`](\w+)['"`]\s*,\s*['"`](\w+)['"`]/.exec(l))) {
      const args = callText(lines, i, m.index + 1);
      push(ctx, 'add_column', table(m[1]), line, args, 'sequelize', {
        column: m[2] ?? '',
        notNull: /allowNull\s*:\s*false/.test(args) || /isNullable\s*:\s*false/.test(args),
        hasDefault: /defaultValue\s*:|default\s*:/.test(args),
      });
      continue;
    }
    if ((m = /\.changeColumn\(\s*['"`](\w+)['"`]\s*,\s*['"`](\w+)['"`]/.exec(l))) {
      const args = callText(lines, i, m.index + 1);
      push(ctx, 'alter_column_type', table(m[1]), line, args, 'sequelize', { column: m[2] ?? '' });
      if (/allowNull\s*:\s*false/.test(args))
        push(ctx, 'set_not_null', table(m[1]), line, args, 'sequelize', { column: m[2] ?? '' });
      continue;
    }
    if (contextTable) {
      if (
        (m = /(?:\btable|\$table|\bt)(?:->|\.)dropColumn\(\s*(\[[^\]]*\]|['"`]\w+['"`])/.exec(l))
      ) {
        for (const c of (m[1] ?? '').matchAll(/['"`](\w+)['"`]/g))
          push(ctx, 'drop_column', contextTable, line, l, 'migration', { column: c[1] ?? '' });
        continue;
      }
      if (
        (m =
          /(?:\btable|\$table|\bt)(?:->|\.)renameColumn\(\s*['"`](\w+)['"`]\s*,\s*['"`](\w+)['"`]/.exec(
            l,
          ))
      ) {
        push(ctx, 'rename_column', contextTable, line, l, 'migration', {
          column: m[1] ?? '',
          newName: m[2] ?? '',
        });
        continue;
      }
      if (
        (m =
          /(?:\btable|\$table|\bt)(?:->|\.)(?!dropColumn|renameColumn|index|unique|primary|foreign|dropIndex|dropForeign|timestamps)(\w+)\(\s*['"`](\w+)['"`]/.exec(
            l,
          ))
      ) {
        const chain = l;
        if (/\.alter\(\)|->change\(\)/.test(chain)) {
          push(ctx, 'alter_column_type', contextTable, line, l, 'migration', {
            column: m[2] ?? '',
          });
          if (/\.notNullable\(\)|->nullable\(false\)/.test(chain))
            push(ctx, 'set_not_null', contextTable, line, l, 'migration', { column: m[2] ?? '' });
        } else {
          push(ctx, 'add_column', contextTable, line, l, 'migration', {
            column: m[2] ?? '',
            notNull:
              /\.notNullable\(\)|->nullable\(false\)/.test(chain) ||
              (lang === 'php' && !/->nullable\(\)/.test(chain)),
            hasDefault:
              /\.defaultTo\(|->default\(|->useCurrent\(\)/.test(chain) ||
              /increments|->id\(/.test(chain),
          });
        }
      }
    }
  }
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

function liquibase(ctx: Ctx, text: string, lineMap: number[]): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    const line = lineMap[i] ?? i + 1;
    const attr = (name: string) =>
      new RegExp(String.raw`\b${name}\s*[=:]\s*["']?([\w.]+)`).exec(l)?.[1] ?? '';
    if (/<dropTable\b|-\s*dropTable:/.test(l))
      push(ctx, 'drop_table', table(attr('tableName')), line, l, 'liquibase');
    else if (/<dropColumn\b|-\s*dropColumn:/.test(l))
      push(ctx, 'drop_column', table(attr('tableName')), line, l, 'liquibase', {
        column: attr('columnName'),
      });
    else if (/<renameColumn\b/.test(l))
      push(ctx, 'rename_column', table(attr('tableName')), line, l, 'liquibase', {
        column: attr('oldColumnName'),
        newName: attr('newColumnName'),
      });
    else if (/<renameTable\b/.test(l))
      push(ctx, 'rename_table', table(attr('oldTableName')), line, l, 'liquibase', {
        newName: table(attr('newTableName')),
      });
    else if (/<addNotNullConstraint\b/.test(l))
      push(ctx, 'set_not_null', table(attr('tableName')), line, l, 'liquibase', {
        column: attr('columnName'),
      });
    else if (/<modifyDataType\b/.test(l))
      push(ctx, 'alter_column_type', table(attr('tableName')), line, l, 'liquibase', {
        column: attr('columnName'),
      });
    else if (/<createTable\b/.test(l))
      push(ctx, 'create_table', table(attr('tableName')), line, l, 'liquibase');
  }
}

/**
 * Extracts schema operations from migration text (usually the added lines of a migration
 * file). `lineMap[i]` maps text line i (0-based) to the file line number.
 */
export function extractSchemaOperations(
  path: string,
  text: string,
  lineMap?: number[],
): SchemaOperation[] {
  const ctx: Ctx = { path, ops: [] };
  if (!text) return ctx.ops;
  const map = lineMap ?? text.split('\n').map((_, i) => i + 1);
  const lang = detectLanguage(path);
  try {
    if (lang === 'sql')
      for (const st of sqlStatements(text, map)) sqlStatement(ctx, st.stmt, st.line);
    else if (lang === 'xml' || lang === 'yaml') liquibase(ctx, text, map);
    else codeMigration(ctx, text, map, lang);
  } catch {
    // best effort
  }
  return dedupeOps(ctx.ops);
}

function dedupeOps(ops: SchemaOperation[]): SchemaOperation[] {
  const seen = new Set<string>();
  return ops.filter((o) => {
    const k = `${o.op}|${o.table}|${o.column ?? ''}|${o.newName ?? ''}|${o.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// ORM schema files: table → columns
// ---------------------------------------------------------------------------

export interface ColumnInfo {
  notNull: boolean;
  hasDefault: boolean;
  type: string;
  line: number;
}

export type TableColumns = Map<string, { line: number; columns: Map<string, ColumnInfo> }>;

const PRISMA_SCALARS = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);

/**
 * Parses table/column definitions from Prisma schemas, Drizzle table definitions and Django
 * models. Returns an empty map for other files.
 */
export function extractTableColumns(
  path: string,
  source: string,
  lineMap?: number[],
): TableColumns {
  const out: TableColumns = new Map();
  if (!source) return out;
  const lines = source.split('\n');
  const ln = (i: number) => lineMap?.[i] ?? i + 1;
  const lang = detectLanguage(path);
  if (lang === 'prisma') {
    const enums = new Set([...source.matchAll(/^\s*enum\s+(\w+)/gm)].map((m) => m[1] ?? ''));
    let current: {
      name: string;
      mapped?: string;
      line: number;
      columns: Map<string, ColumnInfo>;
    } | null = null;
    const flush = () => {
      if (current)
        out.set((current.mapped ?? current.name).toLowerCase(), {
          line: current.line,
          columns: current.columns,
        });
      current = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const l = (lines[i] ?? '').replace(/\/\/.*$/, '');
      const mm = /^\s*model\s+(\w+)\s*\{/.exec(l);
      if (mm?.[1]) {
        flush();
        current = { name: mm[1], line: ln(i), columns: new Map() };
        continue;
      }
      if (!current) continue;
      const cur: { name: string; mapped?: string; line: number; columns: Map<string, ColumnInfo> } =
        current;
      if (/^\s*\}/.test(l)) {
        flush();
        continue;
      }
      const map = /@@map\(\s*(?:name\s*:\s*)?"([^"]+)"/.exec(l);
      if (map?.[1]) {
        cur.mapped = map[1];
        continue;
      }
      const f = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(l);
      if (!f?.[1] || l.trim().startsWith('@@')) continue;
      const type = f[2] ?? '';
      if (!PRISMA_SCALARS.has(type) && !enums.has(type)) continue; // relation field
      if (f[3]) continue; // scalar lists are rare; skip
      const attrs = f[5] ?? '';
      const col = /@map\(\s*"([^"]+)"/.exec(attrs)?.[1] ?? f[1];
      cur.columns.set(col, {
        notNull: !f[4],
        hasDefault: /@default\(|@updatedAt/.test(attrs),
        type: `${type}${f[4] ?? ''}`,
        line: ln(i),
      });
    }
    flush();
    return out;
  }
  if (['typescript', 'javascript', 'tsx'].includes(lang)) {
    let current: {
      name: string;
      line: number;
      columns: Map<string, ColumnInfo>;
      depth: number;
    } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? '';
      const tm = /\b(?:pgTable|mysqlTable|sqliteTable)\(\s*['"`](\w+)['"`]\s*,\s*\{?/.exec(l);
      if (tm?.[1]) {
        current = { name: tm[1].toLowerCase(), line: ln(i), columns: new Map(), depth: 0 };
        out.set(current.name, { line: current.line, columns: current.columns });
        current.depth = (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        continue;
      }
      if (!current) continue;
      // Join continuation lines (`.notNull()` on the next line).
      let def = l;
      let j = i + 1;
      while (j < lines.length && /^\s*\./.test(lines[j] ?? '')) def += (lines[j++] ?? '').trim();
      const cm = /^\s*(\w+)\s*:\s*(\w+)\(\s*(?:['"`](\w+)['"`])?/.exec(l);
      if (cm?.[1] && current.depth === 1) {
        current.columns.set(cm[3] ?? cm[1], {
          notNull: /\.notNull\(\)|\.primaryKey\(\)/.test(def),
          hasDefault:
            /\.default(?:Now|Random)?\(|\.\$default|\.\$defaultFn|\.primaryKey\(\)|\bserial\b|\bbigserial\b|\.generatedAlwaysAs|\.generatedByDefaultAsIdentity|\.generatedAlwaysAsIdentity/.test(
              def,
            ),
          type: cm[2] ?? '',
          line: ln(i),
        });
      }
      current.depth += (l.match(/[{(]/g) ?? []).length - (l.match(/[})]/g) ?? []).length;
      if (current.depth <= 0) current = null;
    }
    return out;
  }
  if (lang === 'python') {
    let current: { key: string; line: number; columns: Map<string, ColumnInfo> } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? '';
      const cm = /^class\s+(\w+)\s*\(\s*(?:[\w.]*\.)?Model\s*\)/.exec(l);
      if (cm?.[1]) {
        current = { key: cm[1].toLowerCase(), line: ln(i), columns: new Map() };
        out.set(current.key, { line: current.line, columns: current.columns });
        continue;
      }
      if (current && /^\S/.test(l) && l.trim()) {
        current = null;
        continue;
      }
      if (!current) continue;
      const dbt = /^\s+db_table\s*=\s*['"](\w+)['"]/.exec(l);
      if (dbt?.[1]) {
        const entry = out.get(current.key);
        out.delete(current.key);
        current.key = dbt[1].toLowerCase();
        if (entry) out.set(current.key, entry);
        continue;
      }
      const fm = /^\s{4}(\w+)\s*=\s*models\.(\w+)\((.*)$/.exec(l);
      if (fm?.[1] && fm[2] !== 'ManyToManyField') {
        const args = callText(lines, i, l.indexOf('models.'));
        current.columns.set(fm[1], {
          notNull: !/\bnull\s*=\s*True\b/.test(args),
          hasDefault: /\bdefault\s*=/.test(args) || /auto_now|AutoField/.test(args + (fm[2] ?? '')),
          type: fm[2] ?? '',
          line: ln(i),
        });
      }
    }
  }
  return out;
}

/**
 * Diffs ORM table/column definitions into schema operations. A removed table whose column
 * set equals an added table's is reported as a rename.
 */
export function diffTableColumns(
  path: string,
  before: TableColumns,
  after: TableColumns,
  source: string,
): SchemaOperation[] {
  const ops: SchemaOperation[] = [];
  const removedTables = [...before.keys()].filter((t) => !after.has(t));
  const addedTables = [...after.keys()].filter((t) => !before.has(t));
  const renamed = new Set<string>();
  for (const r of removedTables) {
    const rCols = [...(before.get(r)?.columns.keys() ?? [])].sort().join(',');
    const match = addedTables.find(
      (a) =>
        !renamed.has(a) &&
        [...(after.get(a)?.columns.keys() ?? [])].sort().join(',') === rCols &&
        rCols !== '',
    );
    if (match) {
      renamed.add(match);
      ops.push({
        op: 'rename_table',
        table: r,
        newName: match,
        path,
        line: after.get(match)?.line ?? 1,
        statement: `${r} → ${match}`,
        source,
      });
    } else {
      ops.push({
        op: 'drop_table',
        table: r,
        path,
        line: before.get(r)?.line ?? 1,
        statement: `table ${r} removed`,
        source,
      });
    }
  }
  for (const a of addedTables)
    if (!renamed.has(a))
      ops.push({
        op: 'create_table',
        table: a,
        path,
        line: after.get(a)?.line ?? 1,
        statement: `table ${a} added`,
        source,
      });
  for (const [t, b] of before) {
    const a = after.get(t);
    if (!a) continue;
    for (const [col, info] of b.columns) {
      const now = a.columns.get(col);
      if (!now) {
        ops.push({
          op: 'drop_column',
          table: t,
          column: col,
          path,
          line: info.line,
          statement: `${t}.${col} removed`,
          source,
        });
        continue;
      }
      if (!info.notNull && now.notNull)
        ops.push({
          op: 'set_not_null',
          table: t,
          column: col,
          path,
          line: now.line,
          statement: `${t}.${col} is now required`,
          source,
        });
      if (info.notNull && !now.notNull)
        ops.push({
          op: 'drop_not_null',
          table: t,
          column: col,
          path,
          line: now.line,
          statement: `${t}.${col} is now optional`,
          source,
        });
      if (info.type.replace(/\?$/, '') !== now.type.replace(/\?$/, ''))
        ops.push({
          op: 'alter_column_type',
          table: t,
          column: col,
          path,
          line: now.line,
          statement: `${t}.${col}: ${info.type} → ${now.type}`,
          source,
        });
    }
    for (const [col, info] of a.columns) {
      if (b.columns.has(col)) continue;
      ops.push({
        op: 'add_column',
        table: t,
        column: col,
        notNull: info.notNull,
        hasDefault: info.hasDefault,
        path,
        line: info.line,
        statement: `${t}.${col} (${info.type}) added`,
        source,
      });
    }
  }
  return ops;
}
