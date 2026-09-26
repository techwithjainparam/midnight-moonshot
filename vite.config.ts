import { readFileSync, existsSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const VALID_NETWORK_IDS = ['undeployed', 'preview', 'preprod'] as const;
const HEX_CONTRACT_RE = /^[0-9a-fA-F]{64}$/;

function validateEnv() {
  const networkId = process.env.VITE_NETWORK_ID ?? 'preprod';
  if (!(VALID_NETWORK_IDS as readonly string[]).includes(networkId)) {
    throw new Error(
      `Invalid VITE_NETWORK_ID "${networkId}". Must be one of: ${VALID_NETWORK_IDS.join(', ')}`,
    );
  }

  const defaultContract = process.env.VITE_DEFAULT_CONTRACT ?? '';
  if (defaultContract && !HEX_CONTRACT_RE.test(defaultContract)) {
    throw new Error(
      `Invalid VITE_DEFAULT_CONTRACT "${defaultContract}". Must be a 64-character hex string (or empty).`,
    );
  }

  const defaultThreshold = process.env.VITE_DEFAULT_THRESHOLD ?? '100000';
  if (!/^\d+$/.test(defaultThreshold.replace(/[,_]/g, ''))) {
    throw new Error(
      `Invalid VITE_DEFAULT_THRESHOLD "${defaultThreshold}". Must be a non-negative integer.`,
    );
  }
}

validateEnv();

// ─── Fixed contract-address injection ─────────────────────────────────────────
//
// When VITE_DEFAULT_CONTRACT is not set, fall back to the deployment recorded
// by `npm run deploy` (.midnight-state.json) for the ACTIVE network. The
// record is injected as a build-time constant (__PRIESTATE_DEPLOYED__) and
// consumed by src/contract-address.ts; absent or mismatched records inject
// null, which makes verification fall back to the deploy path. This file is
// read at build/dev start only — never shipped to the browser.
interface InjectedDeployment {
  network: string;
  address: string;
}

function loadDeployedContract(networkId: string): InjectedDeployment | null {
  const stateFile = '.midnight-state.json';
  if (!existsSync(stateFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
      deployments?: Record<string, { address?: unknown }>;
    };
    const address = parsed.deployments?.[networkId]?.address;
    return typeof address === 'string' && HEX_CONTRACT_RE.test(address)
      ? { network: networkId, address }
      : null;
  } catch {
    return null;
  }
}

const ACTIVE_NETWORK_ID = process.env.VITE_NETWORK_ID ?? 'preprod';
const PRIESTATE_DEPLOYED: InjectedDeployment | null = process.env.VITE_DEFAULT_CONTRACT
  ? null // explicit env config wins; nothing to inject
  : loadDeployedContract(ACTIVE_NETWORK_ID);

export default defineConfig({
  define: {
    __PRIESTATE_DEPLOYED__: JSON.stringify(PRIESTATE_DEPLOYED),
  },
  cacheDir: './.vite',
  build: {
    target: 'esnext',
    minify: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@midnight-ntwrk/onchain-runtime-v3')) return 'wasm';
        },
      },
    },
    commonjsOptions: {
      transformMixedEsModules: true,
      extensions: ['.js', '.cjs'],
      ignoreDynamicRequires: true,
    },
  },
  plugins: [
    react(),
    wasm(),
    topLevelAwait({
      promiseExportName: '__tla',
      promiseImportName: (i) => `__tla_${i}`,
    }),
    {
      name: 'wasm-module-resolver',
      resolveId(source, importer) {
        if (
          source === '@midnight-ntwrk/onchain-runtime-v3' &&
          importer &&
          importer.includes('@midnight-ntwrk/compact-runtime')
        ) {
          return { id: source, external: false, moduleSideEffects: true };
        }
        return null;
      },
    },
  ],
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
      supported: { 'top-level-await': true },
      platform: 'browser',
      format: 'esm',
      loader: { '.wasm': 'binary' },
    },
    include: ['@midnight-ntwrk/compact-runtime'],
    exclude: [
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/onchain-runtime-v3/midnight_onchain_runtime_wasm_bg.wasm',
      '@midnight-ntwrk/onchain-runtime-v3/midnight_onchain_runtime_wasm.js',
    ],
  },
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.wasm'],
    mainFields: ['browser', 'module', 'main'],
  },
  server: {
    port: 3000,
    open: false,
    // Dev proxy so the browser can call the verification API on the same
    // origin (/api/*). The target is a LOCAL process URL — no secrets are
    // involved in the frontend; all credentials live in the server env.
    proxy: {
      '/api': {
        target: process.env.VERIFY_SERVER_ORIGIN ?? 'http://localhost:8787',
        changeOrigin: false,
      },
    },
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'accelerometer=(), camera=(self), geolocation=(self), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
    },
  },
  preview: {
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'accelerometer=(), camera=(self), geolocation=(self), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
    },
  },
});
