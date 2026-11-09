import { z } from 'zod';

// Official SemVer 2.0.0 grammar (semver.org): no leading zeros, optional pre-release and build.
const semver = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    'not a valid SemVer version',
  );
// Paths are resolved relative to the bay folder and must stay inside it.
const relativePath = z
  .string()
  .min(1)
  .refine((p) => !/^[\\/]/.test(p) && !/^[a-zA-Z]:/.test(p) && !p.split(/[\\/]/).includes('..'), {
    message: 'must be a relative path inside the bay',
  });

const bayIdPattern = '[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+';
const functionNamePattern = '[a-zA-Z][a-zA-Z0-9]*(?:\\.[a-zA-Z][a-zA-Z0-9]*)*';

const FunctionSchema = z.object({
  /** Dotted name, e.g. `session.setStatus`; callable as `<bay-id>/<name>`. */
  name: z.string().regex(new RegExp(`^${functionNamePattern}$`), 'invalid function name'),
  /** Never granted to agents automatically; see ADR 0006. Defaults to `false`. */
  sensitive: z.boolean().default(false),
  /** Agents of every bay may call it without asking; only for non-sensitive functions (ADR 0016). */
  openToAgents: z.boolean().optional(),
  /** Other Hangar instances may call it once a workspace shares it; never sensitive (ADR 0011). */
  remote: z.boolean().optional(),
  /** Only other bays may call it: no MCP tool, never an agent or another instance (ADR 0021). */
  bayOnly: z.boolean().optional(),
  /** Shown to MCP clients as the tool description. */
  description: z.string().optional(),
});

const Texts = z.object({
  /** German text. */
  de: z.string().min(1),
  /** English text. */
  en: z.string().min(1),
});

const settingBase = {
  /** Name for `ctx.settings.get`, unique within the bay. */
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'invalid setting key'),
  /** Label in the app's settings. */
  label: Texts,
  /** Hint below the label. */
  description: Texts.optional(),
};

/** A setting shown in the app's settings: a check box (ADR 0023) or a text field (ADR 0025). */
const SettingSchema = z.discriminatedUnion('type', [
  z.object({
    ...settingBase,
    /** Shown as a check box. */
    type: z.literal('boolean'),
    /** Value until the person changes it. */
    default: z.boolean(),
  }),
  z.object({
    ...settingBase,
    /** Shown as a text field. */
    type: z.literal('text'),
    /** Value until the person changes it. */
    default: z.string(),
  }),
]);

/** Schema of `manifest.json` in every bay folder. */
export const BayManifestSchema = z
  .object({
    /** Unique reverse-domain id, e.g. `dev.hangar.agents`. */
    id: z
      .string()
      .regex(new RegExp(`^${bayIdPattern}$`), 'must be in reverse-domain style')
      // Functions of other instances live under `remote.<name>.<bay-id>` (ADR 0011).
      .refine((id) => !id.startsWith('remote.'), 'the prefix "remote." is reserved'),
    /** Display name in the sidebar. */
    name: z.string().min(1),
    /** SemVer version of the bay. */
    version: semver,
    /** Hangar refuses to load the bay if its own version is lower. */
    minHangarVersion: semver.optional(),
    /** Sidebar icon (SVG), relative to the bay folder. */
    icon: relativePath,
    /** HTML entry of the bay UI, relative to the bay folder. */
    ui: relativePath,
    /** ES module exporting a `BayMain` as default; runs in the main process. */
    main: relativePath.optional(),
    /** Functions the bay offers on the bus and via MCP. */
    functions: z.array(FunctionSchema).default([]),
    /**
     * Host capabilities beyond the bay context: `browser` for web page tabs (ADR 0015),
     * `workspaces` to share state with other instances (ADR 0030), `secrets` to encrypt with
     * the system keychain (ADR 0021).
     */
    hostModules: z.array(z.enum(['browser', 'workspaces', 'secrets'])).optional(),
    /** Functions of other bays the main part calls (`<bay-id>/<function>`); the host refuses others. */
    uses: z
      .array(
        z
          .string()
          .regex(
            new RegExp(`^${bayIdPattern}/${functionNamePattern}$`),
            'must be <bay-id>/<function>',
          ),
      )
      .optional(),
    /** Only then may the bay issue agent session tokens with `registerAgentSession` (ADR 0012). */
    agentSessions: z.boolean().optional(),
    /** Format version of the bay's data; a change makes Hangar back the data up on update. */
    dataVersion: z.number().int().min(0).optional(),
    /** Settings shown in the app's settings; the bay reads them with `ctx.settings` (ADR 0023). */
    settings: z.array(SettingSchema).optional(),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const f of m.functions) {
      if (seen.has(f.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['functions'],
          message: `Duplicate function name "${f.name}"`,
        });
      }
      seen.add(f.name);
      if (f.sensitive && f.openToAgents) {
        ctx.addIssue({
          code: 'custom',
          path: ['functions'],
          message: `Function "${f.name}" cannot be sensitive and open to agents`,
        });
      }
      if (f.bayOnly && (f.openToAgents || f.remote)) {
        ctx.addIssue({
          code: 'custom',
          path: ['functions'],
          message: `Function "${f.name}" is only for bays`,
        });
      }
      if (f.sensitive && f.remote) {
        ctx.addIssue({
          code: 'custom',
          path: ['functions'],
          message: `Function "${f.name}" cannot be sensitive and remote`,
        });
      }
    }
    const keys = m.settings?.map((s) => s.key) ?? [];
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['settings'], message: 'Duplicate setting key' });
    }
  });

/** A validated bay manifest. */
export type BayManifest = z.infer<typeof BayManifestSchema>;

/** Result of {@link parseManifest}. */
export type ManifestResult =
  | {
      /** Validation succeeded. */
      ok: true;
      /** The manifest with defaults applied. */
      manifest: BayManifest;
    }
  | {
      /** Validation failed. */
      ok: false;
      /** `<field>: <message>`, e.g. `id: must be in reverse-domain style`. */
      error: string;
    };

/** Validates untrusted manifest JSON; errors are human-readable and name the field. */
export function parseManifest(input: unknown): ManifestResult {
  const result = BayManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  const issue = result.error.issues[0]!;
  return { ok: false, error: `${issue.path.join('.') || 'manifest'}: ${issue.message}` };
}
