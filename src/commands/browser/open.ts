import type { Command, CommandGenerator } from '../../types';
import { chromium } from 'playwright';
import { loadConfig } from '../../config.ts';
import { ensurePlaywright } from './utils.ts';
import type { OpenCommandOptions } from './browserOptions';
import {
  setupConsoleLogging,
  setupNetworkMonitoring,
  captureScreenshot,
  outputMessages,
  setupVideoRecording,
  stopVideoRecording,
} from './utilsShared';

// Helper function to parse time duration string to milliseconds
function parseTimeDuration(duration: string): number | null {
  const timeRegex = /^(\d+)(ms|s|m)$/;
  const match = duration.match(timeRegex);
  if (!match) return null;

  const [, value, unit] = match;
  const numValue = parseInt(value, 10);

  switch (unit) {
    case 'ms':
      return numValue;
    case 's':
      return numValue * 1000;
    case 'm':
      return numValue * 60 * 1000;
    default:
      return null;
  }
}

// Helper function to parse wait parameter
function parseWaitParameter(wait: string): { type: 'time' | 'selector'; value: string | number } {
  // Check for explicit prefixes first
  if (wait.startsWith('time:')) {
    const duration = parseTimeDuration(wait.slice(5));
    if (duration === null) {
      throw new Error(
        `Invalid time duration format: ${wait}. Expected format: time:Xs, time:Xms, or time:Xm`
      );
    }
    return { type: 'time', value: duration };
  }

  if (wait.startsWith('selector:') || wait.startsWith('css:')) {
    const selector = wait.includes(':') ? wait.slice(wait.indexOf(':') + 1) : wait;
    return { type: 'selector', value: selector };
  }

  // Try parsing as time duration
  const duration = parseTimeDuration(wait);
  if (duration !== null) {
    return { type: 'time', value: duration };
  }

  // If it starts with # or ., treat as CSS selector
  if (wait.startsWith('#') || wait.startsWith('.')) {
    return { type: 'selector', value: wait };
  }

  // Default to treating as CSS selector
  return { type: 'selector', value: wait };
}

export class OpenCommand implements Command {
  private config = loadConfig();

  async *execute(query: string, options?: OpenCommandOptions): CommandGenerator {
    try {
      // Check for Playwright availability first
      await ensurePlaywright();

      // Parse options from query if not provided
      if (!options?.url && query) {
        options = { ...options, url: query };
      }

      if (!options?.url) {
        yield 'Please provide a URL to open. Usage: cursor-tools browser open <url> [options]';
        return;
      }

      const url = options.url;

      // Set default values for html, network, and console options if not provided
      options = {
        ...options,
        html: options.html === undefined ? false : options.html,
        network: options.network === undefined ? true : options.network,
        console: options.console === undefined ? true : options.console,
      };

      const browserType = chromium;
      let browser;
      let context;
      let page;
      let consoleMessages: string[] = [];
      let networkMessages: string[] = [];
      let videoPath: string | null = null;

      try {
        if (options.connectTo) {
          yield `Connecting to existing Chrome instance on port ${options.connectTo}...`;
          browser = await browserType.connectOverCDP(`http://localhost:${options.connectTo}`);
          context =
            (await browser.contexts()[0]) ||
            (await browser.newContext({
              recordVideo: options.video
                ? {
                    dir: videoPath!,
                    size: { width: 1280, height: 720 },
                  }
                : undefined,
              serviceWorkers: 'allow',
              extraHTTPHeaders: {
                Accept:
                  'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
              },
            }));

          // Get existing pages or create new one
          const pages = await context.pages();
          if (url === 'current' && pages.length > 0) {
            // Find the first page that isn't a new tab page
            page = pages.find((p) => !p.url().startsWith('chrome://')) || pages[pages.length - 1];
            yield 'Using existing page...';
          } else if (pages.length > 0 && options.connectTo) {
            // When connecting to existing Chrome, prefer reusing an existing page
            page = pages.find((p) => !p.url().startsWith('chrome://')) || pages[0];
            yield 'Using existing page for navigation...';
          } else {
            page = await context.newPage();
          }

          if (options.viewport) {
            const [width, height] = options.viewport.split('x').map(Number);
            if (!isNaN(width) && !isNaN(height)) {
              await page.setViewportSize({ width, height });
            }
          }
        } else {
          yield 'Launching browser...';
          browser = await browserType.launch({
            headless:
              options.headless !== undefined
                ? options.headless
                : (this.config.browser?.headless ?? true),
          });

          videoPath = await setupVideoRecording(options);
          console.log('videoPath', videoPath);
          context = await browser.newContext({
            recordVideo: options.video
              ? {
                  dir: videoPath!,
                  size: { width: 1280, height: 720 },
                }
              : undefined,
            serviceWorkers: 'allow',
            extraHTTPHeaders: {
              Accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            },
          });
          page = await context.newPage();
        }

        // Set up console and network monitoring
        consoleMessages = await setupConsoleLogging(page, options);
        networkMessages = await setupNetworkMonitoring(page, options);

        if (options.viewport) {
          const [width, height] = options.viewport.split('x').map(Number);
          if (!isNaN(width) && !isNaN(height)) {
            await page.setViewportSize({ width, height });
          } else {
            yield `Invalid viewport format: ${options.viewport}. Expected format: <width>x<height> (e.g. 1280x720)`;
          }
        } else if (this.config.browser?.defaultViewport) {
          const [width, height] = this.config.browser.defaultViewport.split('x').map(Number);
          if (!isNaN(width) && !isNaN(height)) {
            await page.setViewportSize({ width, height });
          }
        }

        // Only navigate if not using 'current' URL or if there's no existing page
        if (!(url === 'current' && options.connectTo)) {
          yield `Navigating to ${url}...`;
          await page.goto(url, {
            timeout: options.timeout ?? this.config.browser?.timeout ?? 30000,
          });
        } else {
          yield `Using current page at ${await page.url()}...`;
        }

        // Handle wait parameter if provided
        if (options.wait) {
          try {
            const waitConfig = parseWaitParameter(options.wait);
            yield `Waiting for ${waitConfig.type === 'time' ? `${waitConfig.value}ms` : `selector "${waitConfig.value}"`}...`;

            if (waitConfig.type === 'time') {
              await page.waitForTimeout(waitConfig.value as number);
            } else {
              await page.waitForSelector(waitConfig.value as string, {
                state: 'visible',
                timeout: options.timeout ?? this.config.browser?.timeout ?? 30000,
              });
            }
          } catch (error) {
            yield `Wait error: ${error instanceof Error ? error.message : 'Unknown error'}\n`;
          }
        }

        // Output console and network messages
        for (const message of outputMessages(consoleMessages, networkMessages, options)) {
          yield message;
        }

        // Only output HTML content if explicitly enabled
        if (options.html === true) {
          const htmlContent = await page.content();
          yield '\n--- Page HTML Content ---\n\n';
          yield htmlContent;
          yield '\n--- End of HTML Content ---\n';
        }

        // Take screenshot if requested
        await captureScreenshot(page, options);
        if (options.screenshot) {
          yield `Screenshot saved to ${options.screenshot}\n`;
        }
      } catch (error) {
        yield `Browser command error: ${error instanceof Error ? error.message : 'Unknown error'}`;
      } finally {
        if (videoPath && page) {
          const videoMessage = await stopVideoRecording(page, videoPath);
          if (videoMessage) {
            yield videoMessage;
          }
        }
        if (browser) {
          await browser.close();
          yield 'Browser closed.\n';
        }
      }
    } catch (error) {
      yield `Playwright check error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
}
