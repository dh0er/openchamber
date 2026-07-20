const SAFE_CHILD_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'ELECTRON_BUILDER_CACHE',
  'ELECTRON_CACHE',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
]);

const PROXY_KEYS = new Set(['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);

export const createSafeChildEnvironment = (baseEnvironment, { includeProxy = true } = {}) => Object.fromEntries(
  Object.entries(baseEnvironment || {}).filter(([key]) => {
    const normalized = key.toUpperCase();
    return SAFE_CHILD_ENVIRONMENT_KEYS.has(normalized) && (includeProxy || !PROXY_KEYS.has(normalized));
  }),
);
