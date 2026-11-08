export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'USAGE';
  }
}

export function parseArgs(argv) {
  const args = { format: 'table', autoLimit: true, queries: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value.`);
      return v;
    };
    switch (a) {
      case '--list-targets': args.listTargets = true; break;
      case '--bootstrap': args.bootstrap = true; break;
      case '--target': args.target = next(); break;
      case '--list-tables': args.listTables = true; break;
      case '--describe': args.describe = next(); break;
      case '--sql': args.queries.push({ kind: 'sql', value: next() }); break;
      case '--file': args.queries.push({ kind: 'file', value: next() }); break;
      case '--format': {
        args.format = next();
        if (!['table', 'json'].includes(args.format)) throw new UsageError(`--format must be table or json, got "${args.format}".`);
        break;
      }
      case '--limit': {
        const raw = next();
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) throw new UsageError(`--limit must be a positive integer, got "${raw}".`);
        args.limit = n;
        break;
      }
      case '--no-auto-limit': args.autoLimit = false; break;
      case '--accept-host-key': args.acceptHostKey = next(); break;
      case '--close-tunnel': args.closeTunnel = true; break;
      case '--verbose': args.verbose = true; break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        throw new UsageError(`Unknown argument: ${a}`);
    }
  }
  return args;
}
