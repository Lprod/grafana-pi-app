export type CodeTokenKind =
  | 'comment'
  | 'keyword'
  | 'string'
  | 'number'
  | 'builtin'
  | 'key'
  | 'operator'
  | 'punctuation';

export type CodeToken = {
  text: string;
  kind?: CodeTokenKind;
};

export type JsonnetCodeLine = {
  line: number;
  text: string;
};

const JSONNET_HIGHLIGHT_MAX_LINES = 1000;
const JSONNET_HIGHLIGHT_MAX_CHARS = 120000;

const jsonnetKeywords = new Set([
  'assert',
  'else',
  'error',
  'false',
  'for',
  'function',
  'if',
  'import',
  'importbin',
  'importstr',
  'in',
  'local',
  'null',
  'self',
  'super',
  'tailstrict',
  'then',
  'true',
]);

const jsonnetBuiltins = new Set(['std']);

export function shouldHighlightJsonnet(lines: JsonnetCodeLine[]) {
  if (lines.length > JSONNET_HIGHLIGHT_MAX_LINES) {
    return false;
  }
  let charCount = 0;
  for (const line of lines) {
    charCount += line.text.length;
    if (charCount > JSONNET_HIGHLIGHT_MAX_CHARS) {
      return false;
    }
  }
  return true;
}

export function highlightJsonnetLines(lines: JsonnetCodeLine[]): CodeToken[][] {
  const state = { blockComment: false };
  return lines.map((line) => highlightJsonnetLine(line.text, state));
}

function highlightJsonnetLine(line: string, state: { blockComment: boolean }): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;

  const push = (text: string, kind?: CodeTokenKind) => {
    if (text) {
      tokens.push({ text, kind });
    }
  };

  while (index < line.length) {
    if (state.blockComment) {
      const end = line.indexOf('*/', index);
      if (end === -1) {
        push(line.slice(index), 'comment');
        return tokens;
      }
      push(line.slice(index, end + 2), 'comment');
      state.blockComment = false;
      index = end + 2;
      continue;
    }

    const nextTwo = line.slice(index, index + 2);
    if (nextTwo === '//' || line[index] === '#') {
      push(line.slice(index), 'comment');
      return tokens;
    }
    if (nextTwo === '/*') {
      const end = line.indexOf('*/', index + 2);
      if (end === -1) {
        push(line.slice(index), 'comment');
        state.blockComment = true;
        return tokens;
      }
      push(line.slice(index, end + 2), 'comment');
      index = end + 2;
      continue;
    }

    const quote = line[index];
    if (quote === '"' || quote === "'") {
      const end = jsonnetStringEnd(line, index, quote);
      push(line.slice(index, end), 'string');
      index = end;
      continue;
    }

    const numberMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(line.slice(index));
    if (numberMatch && isNumberBoundary(line, index, numberMatch[0].length)) {
      push(numberMatch[0], 'number');
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(index));
    if (identifierMatch) {
      const value = identifierMatch[0];
      push(value, jsonnetIdentifierKind(line, index, index + value.length, value));
      index += value.length;
      continue;
    }

    if (isJsonnetOperatorChar(line[index])) {
      push(line[index], 'operator');
    } else if (isJsonnetPunctuationChar(line[index])) {
      push(line[index], 'punctuation');
    } else {
      push(line[index]);
    }
    index++;
  }

  return tokens;
}

function jsonnetStringEnd(line: string, start: number, quote: string) {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] === quote) {
      return index + 1;
    }
    index++;
  }
  return line.length;
}

function isNumberBoundary(line: string, start: number, length: number) {
  const before = start > 0 ? line[start - 1] : '';
  const after = line[start + length] ?? '';
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}

function jsonnetIdentifierKind(line: string, start: number, end: number, value: string): CodeTokenKind | undefined {
  if (jsonnetKeywords.has(value)) {
    return 'keyword';
  }
  if (jsonnetBuiltins.has(value)) {
    return 'builtin';
  }
  if (isJsonnetObjectKey(line, start, end)) {
    return 'key';
  }
  return undefined;
}

function isJsonnetObjectKey(line: string, start: number, end: number) {
  const before = previousNonWhitespace(line, start);
  if (before === '.') {
    return false;
  }
  const next = line.slice(end).trimStart();
  return next.startsWith(':') || next.startsWith('+:');
}

function previousNonWhitespace(line: string, beforeIndex: number) {
  for (let index = beforeIndex - 1; index >= 0; index--) {
    if (!/\s/.test(line[index])) {
      return line[index];
    }
  }
  return undefined;
}

function isJsonnetOperatorChar(value: string) {
  return '+-*/%=!<>|&~'.includes(value);
}

function isJsonnetPunctuationChar(value: string) {
  return '{}[]().,:;'.includes(value);
}

export function partialJsonStringField(source: string, field: string) {
  const match = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"`).exec(source);
  if (!match) {
    return undefined;
  }

  let index = match.index + match[0].length;
  let value = '';
  while (index < source.length) {
    const character = source[index++];
    if (character === '"') {
      return value;
    }
    if (character !== '\\') {
      value += character;
      continue;
    }
    if (index >= source.length) {
      return value;
    }
    const escape = source[index++];
    switch (escape) {
      case '"':
      case '\\':
      case '/':
        value += escape;
        break;
      case 'b':
        value += '\b';
        break;
      case 'f':
        value += '\f';
        break;
      case 'n':
        value += '\n';
        break;
      case 'r':
        value += '\r';
        break;
      case 't':
        value += '\t';
        break;
      case 'u': {
        const hex = source.slice(index, index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return value;
        }
        value += String.fromCharCode(parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        value += escape;
        break;
    }
  }
  return value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function utf8ByteLength(value: string) {
  return typeof TextEncoder === 'undefined' ? value.length : new TextEncoder().encode(value).length;
}
