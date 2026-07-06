import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_VIEWER_PORT || 5180);

function commandExists(command) {
    try {
        execFileSync('which', [command], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function localBrowserChannel() {
    if (process.env.PLAYWRIGHT_BROWSER_CHANNEL) {
        return process.env.PLAYWRIGHT_BROWSER_CHANNEL;
    }
    if (!process.env.CI && commandExists('google-chrome')) {
        return 'chrome';
    }
    return undefined;
}

const chromiumChannel = localBrowserChannel();
const projects = [{
    name: chromiumChannel || 'chromium',
    use: {
        ...devices['Desktop Chrome'],
        ...(chromiumChannel ? { channel: chromiumChannel } : {}),
    },
}];

if (process.env.PLAYWRIGHT_ALL_BROWSERS === '1') {
    projects.push(
        {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'] },
        },
        {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
        },
    );
}

export default defineConfig({
    testDir: './tests/browser',
    timeout: 30000,
    expect: {
        timeout: 5000,
    },
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        headless: true,
        trace: 'retain-on-failure',
    },
    webServer: {
        command: `npm run dev:viewer -- --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
    },
    projects,
});
