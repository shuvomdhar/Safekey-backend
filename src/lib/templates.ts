export const FOLDER_COLORS = ['olive', 'sage', 'clay', 'sand', 'slate', 'plum'] as const;
export const FOLDER_ICONS = [
  'folder',
  'key',
  'globe',
  'bank',
  'briefcase',
  'user',
  'cloud',
  'gamepad',
  'mail',
  'lock',
  'code',
  'camera'
] as const;
export const COLUMN_TYPES = [
  'text',
  'password',
  'email',
  'username',
  'url',
  'note',
  'number',
  'date'
] as const;

export const TEMPLATE_KEYS = ['blank', 'login', 'social', 'api', 'banking', 'identity'] as const;

export type FolderColor = (typeof FOLDER_COLORS)[number];
export type FolderIcon = (typeof FOLDER_ICONS)[number];
export type ColumnType = (typeof COLUMN_TYPES)[number];
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export type TemplateColumn = {
  name: string;
  type: ColumnType;
  isSecret?: boolean;
  isRequired?: boolean;
};

export const FOLDER_TEMPLATES: Record<
  TemplateKey,
  { label: string; description: string; columns: TemplateColumn[] }
> = {
  blank: {
    label: 'Blank vault',
    description: 'Start with no columns and shape it yourself.',
    columns: []
  },
  login: {
    label: 'Website login',
    description: 'Username, password and website — the classic trio.',
    columns: [
      { name: 'Username', type: 'username' },
      { name: 'Password', type: 'password', isSecret: true, isRequired: true },
      { name: 'Website', type: 'url' }
    ]
  },
  social: {
    label: 'Social accounts',
    description: 'Multiple accounts per platform, plus recovery details.',
    columns: [
      { name: 'Username', type: 'username' },
      { name: 'Email', type: 'email' },
      { name: 'Password', type: 'password', isSecret: true, isRequired: true },
      { name: 'Recovery email', type: 'email' },
      { name: '2FA backup codes', type: 'note', isSecret: true }
    ]
  },
  api: {
    label: 'API & developer keys',
    description: 'Keys, environments and documentation links.',
    columns: [
      { name: 'API key', type: 'password', isSecret: true, isRequired: true },
      { name: 'Environment', type: 'text' },
      { name: 'Docs', type: 'url' },
      { name: 'Expires on', type: 'date' }
    ]
  },
  banking: {
    label: 'Banking & cards',
    description: 'Account numbers, PINs and branch details.',
    columns: [
      { name: 'Account holder', type: 'text' },
      { name: 'Account number', type: 'text' },
      { name: 'PIN', type: 'password', isSecret: true },
      { name: 'Routing number', type: 'text' },
      { name: 'Website', type: 'url' }
    ]
  },
  identity: {
    label: 'Identity documents',
    description: 'Passports, licences and other IDs.',
    columns: [
      { name: 'Full name', type: 'text' },
      { name: 'Document number', type: 'text' },
      { name: 'Issued on', type: 'date' },
      { name: 'Expires on', type: 'date' },
      { name: 'Notes', type: 'note' }
    ]
  }
};
