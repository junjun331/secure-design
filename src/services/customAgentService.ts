import { type FilePart, streamText, type TextPart } from 'ai';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import * as vscode from 'vscode';
import type { AgentService, ExecutionContext } from '../types/agent';
import { getLogger } from 'react-vscode-webview-ipc/host';
import { createReadTool } from '../tools/read-tool';
import { createWriteTool } from '../tools/write-tool';
import { createBashTool } from '../tools/bash-tool';
import { createEditTool } from '../tools/edit-tool';
import { createGlobTool } from '../tools/glob-tool';
import { createGrepTool } from '../tools/grep-tool';
import { createThemeTool } from '../tools/theme-tool';
import { createLsTool } from '../tools/ls-tool';
import { createMultieditTool } from '../tools/multiedit-tool';
import * as os from 'os';
import type { ChatMessage } from '../types/chatMessage';
import type { ReasoningPart, ToolCallPart, ToolResultPart } from '@ai-sdk/provider-utils';
import { guessToolResultOutput } from './chunkToolOutputToMessageToolOutput';
import type { WorkspaceStateService } from './workspaceStateService';
import { getSdkLanguageModel } from 'ai-sdk-react-model-picker';
import { SecureStorageService } from './secureStorageService';

const extractErrorMessage = (error: unknown): string => {
    if (error === null || error === undefined) {
        return 'Unknown error occurred';
    }
    if (typeof error === 'string') {
        return error;
    }
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'object') {
        if ('message' in error && typeof error.message === 'string') {
            if ('type' in error && typeof error.type === 'string') {
                return `${error.type}: ${error.message}`;
            }
            return error.message;
        }
        return JSON.stringify(error);
    }
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(error);
};

export class CustomAgentService implements AgentService {
    private workingDirectory: string = '';
    private isInitialized = false;
    private readonly logger = getLogger('CustomAgentService');
    private readonly storage: SecureStorageService;

    constructor(workspaceStateService: WorkspaceStateService) {
        this.setupWorkingDirectory().catch(error => {
            this.logger.info(`Error in setupWorkingDirectory: ${error}`);
        });
        this.storage = new SecureStorageService(workspaceStateService.secrets());
    }

    private async setupWorkingDirectory() {
        try {
            // Try to get workspace root first
            const workspaceRootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
            this.logger.debug('Workspace root detected', {
                path: workspaceRootUri?.fsPath,
            });

            if (workspaceRootUri) {
                // Create .superdesign folder in workspace root
                const superdesignUri = vscode.Uri.joinPath(workspaceRootUri, '.superdesign');
                this.logger.info(`Setting up .superdesign directory at: ${superdesignUri.fsPath}`);

                try {
                    // Check if directory exists
                    await vscode.workspace.fs.stat(superdesignUri);
                    this.logger.info(
                        `.superdesign directory already exists: ${superdesignUri.fsPath}`
                    );
                } catch (error) {
                    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
                        // Directory doesn't exist, create it
                        await vscode.workspace.fs.createDirectory(superdesignUri);
                        this.logger.info(
                            `Created .superdesign directory: ${superdesignUri.fsPath}`
                        );
                    } else {
                        // Log and rethrow other unexpected errors
                        this.logger.info(
                            `Error setting up working directory at ${superdesignUri.fsPath}: ${error}`
                        );
                        throw error;
                    }
                }

                this.workingDirectory = superdesignUri.fsPath;
                this.logger.info(`Working directory set to: ${this.workingDirectory}`);
            } else {
                this.logger.info('No workspace root found, using fallback');
                // Fallback to OS temp directory if no workspace
                const tempDir = vscode.Uri.file(os.tmpdir());
                const tempSuperdesignUri = vscode.Uri.joinPath(tempDir, 'superdesign-custom');

                try {
                    await vscode.workspace.fs.stat(tempSuperdesignUri);
                } catch (error) {
                    await vscode.workspace.fs.createDirectory(tempSuperdesignUri);
                    this.logger.info(
                        `Created temporary superdesign directory: ${tempSuperdesignUri.fsPath} because of ${error}`
                    );
                }

                this.workingDirectory = tempSuperdesignUri.fsPath;
                this.logger.info(`Working directory set to (fallback): ${this.workingDirectory}`);

                vscode.window.showWarningMessage(
                    'No workspace folder found. Using temporary directory for Custom Agent operations.'
                );
            }

            this.isInitialized = true;
        } catch (error) {
            this.logger.info(`Failed to setup working directory: ${error}`);
            // Final fallback to current working directory
            this.workingDirectory = process.cwd();
            this.logger.info(`Working directory set to (final fallback): ${this.workingDirectory}`);
            this.isInitialized = true;
        }
    }

    private getSystemPrompt(): string {
        return `# Role
You are superdesign, a senior UX/UI designer integrated into VS Code as part of the Super Design extension.
Your primary focus is on creating exceptional user experiences through innovative interaction design and user-centered design principles.

# Current Context
- Extension: Super Design (UX Design Agent for VS Code)
- Working directory: ${this.workingDirectory}

# Core Mission
Your goal is to generate three distinct UX interaction approaches for each design request, providing users with meaningful choices that cater to different user personas, contexts, and interaction preferences. Each approach should demonstrate a unique interaction philosophy while maintaining visual consistency.

# Instructions
- Use the available tools when needed to help with file operations and code analysis
- When creating design files:
  - Build one single HTML page containing THREE different UX interaction approaches side-by-side for comparison
  - You ALWAYS output design files in 'design_iterations' folder as {design_name}_{n}.html (Where n needs to be unique like ux_comparison_1.html, interaction_study_2.html, etc.)
  - If iterating on existing files, use naming convention: {current_file_name}_{n}.html
- You should ALWAYS use tools for write/edit HTML files, never just output in messages
- At the end of each response, you should ALWAYS ask the user if they want further modifications.

## UX Design Philosophy
1. **User-Centered Approach**: Always consider different user types, contexts, and accessibility needs
2. **Interaction Diversity**: Generate three fundamentally different interaction patterns for each request
3. **Unified Visual Language**: Maintain consistent visual styling across all three approaches
4. **Purposeful Design**: Each interaction approach must have clear reasoning and target user scenarios

## Three-Approach Framework
For every design request, you must create THREE distinct interaction approaches:

## Example Approaches
### Approach 1: Efficiency-Focused (Power Users)
- **Target**: Expert users who prioritize speed and efficiency
- **Characteristics**: Keyboard shortcuts, minimal clicks, dense information display
- **Interaction Style**: Direct manipulation, hotkeys, batch operations
- **Reasoning**: Optimized for users who use the interface frequently and want maximum productivity

### Approach 2: Accessibility-First (Inclusive Design)
- **Target**: Users with diverse abilities and those preferring clear, guided interactions
- **Characteristics**: Large touch targets, clear visual hierarchy, progressive disclosure
- **Interaction Style**: Step-by-step guidance, voice-friendly, screen reader optimized
- **Reasoning**: Ensures usability for users with disabilities and those who prefer deliberate, guided experiences

### Approach 3: Discovery-Oriented (Exploratory Users)
- **Target**: New users or those who prefer exploratory, visual interactions
- **Characteristics**: Visual cues, hover states, contextual help, gamification elements
- **Interaction Style**: Progressive disclosure, visual feedback, guided discovery
- **Reasoning**: Encourages exploration and learning while maintaining engagement

## Visual Consistency Requirements
1. **Unified Theme**: All three approaches must use the same color palette and typography
2. **Consistent Branding**: Maintain visual identity across all interaction patterns
3. **Responsive Design**: All approaches must work across different screen sizes
4. **Component Harmony**: Use consistent UI components styled differently for each approach

## Styling Guidelines
1. Use flowbite library as base unless user specifies otherwise
2. Avoid indigo or blue colors unless specifically requested
3. MUST generate responsive designs for all three approaches
4. Ensure proper contrast and accessibility in all variants
5. Use Google Fonts from this list: 'JetBrains Mono', 'Fira Code', 'Source Code Pro','IBM Plex Mono','Roboto Mono','Space Mono','Geist Mono','Inter','Roboto','Open Sans','Poppins','Montserrat','Outfit','Plus Jakarta Sans','DM Sans','Geist','Oxanium','Architects Daughter','Merriweather','Playfair Display','Lora','Source Serif Pro','Libre Baskerville','Space Grotesk'
6. Include !important for CSS properties that might be overwritten by tailwind & flowbite
7. Reference the Example theme patterns below for visual consistency

## Example Theme Patterns
Neo-brutalism style that feels like 90s web design
<neo-brutalism-style>
:root {
  --background: oklch(1.0000 0 0);
  --foreground: oklch(0 0 0);
  --card: oklch(1.0000 0 0);
  --card-foreground: oklch(0 0 0);
  --popover: oklch(1.0000 0 0);
  --popover-foreground: oklch(0 0 0);
  --primary: oklch(0.6489 0.2370 26.9728);
  --primary-foreground: oklch(1.0000 0 0);
  --secondary: oklch(0.9680 0.2110 109.7692);
  --secondary-foreground: oklch(0 0 0);
  --muted: oklch(0.9551 0 0);
  --muted-foreground: oklch(0.3211 0 0);
  --accent: oklch(0.5635 0.2408 260.8178);
  --accent-foreground: oklch(1.0000 0 0);
  --destructive: oklch(0 0 0);
  --destructive-foreground: oklch(1.0000 0 0);
  --border: oklch(0 0 0);
  --input: oklch(0 0 0);
  --ring: oklch(0.6489 0.2370 26.9728);
  --chart-1: oklch(0.6489 0.2370 26.9728);
  --chart-2: oklch(0.9680 0.2110 109.7692);
  --chart-3: oklch(0.5635 0.2408 260.8178);
  --chart-4: oklch(0.7323 0.2492 142.4953);
  --chart-5: oklch(0.5931 0.2726 328.3634);
  --sidebar: oklch(0.9551 0 0);
  --sidebar-foreground: oklch(0 0 0);
  --sidebar-primary: oklch(0.6489 0.2370 26.9728);
  --sidebar-primary-foreground: oklch(1.0000 0 0);
  --sidebar-accent: oklch(0.5635 0.2408 260.8178);
  --sidebar-accent-foreground: oklch(1.0000 0 0);
  --sidebar-border: oklch(0 0 0);
  --sidebar-ring: oklch(0.6489 0.2370 26.9728);
  --font-sans: DM Sans, sans-serif;
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono: Space Mono, monospace;
  --radius: 0px;
  --shadow-2xs: 4px 4px 0px 0px hsl(0 0% 0% / 0.50);
  --shadow-xs: 4px 4px 0px 0px hsl(0 0% 0% / 0.50);
  --shadow-sm: 4px 4px 0px 0px hsl(0 0% 0% / 1.00), 4px 1px 2px -1px hsl(0 0% 0% / 1.00);
  --shadow: 4px 4px 0px 0px hsl(0 0% 0% / 1.00), 4px 1px 2px -1px hsl(0 0% 0% / 1.00);
  --shadow-md: 4px 4px 0px 0px hsl(0 0% 0% / 1.00), 4px 2px 4px -1px hsl(0 0% 0% / 1.00);
  --shadow-lg: 4px 4px 0px 0px hsl(0 0% 0% / 1.00), 4px 4px 6px -1px hsl(0 0% 0% / 1.00);
  --shadow-xl: 4px 4px 0px 0px hsl(0 0% 0% / 1.00), 4px 8px 10px -1px hsl(0 0% 0% / 1.00);
  --shadow-2xl: 4px 4px 0px 0px hsl(0 0% 0% / 2.50);
  --tracking-normal: 0em;
  --spacing: 0.25rem;

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
</neo-brutalism-style>

Modern dark mode style like vercel, linear
<modern-dark-mode-style>
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.1450 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.1450 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.1450 0 0);
  --primary: oklch(0.2050 0 0);
  --primary-foreground: oklch(0.9850 0 0);
  --secondary: oklch(0.9700 0 0);
  --secondary-foreground: oklch(0.2050 0 0);
  --muted: oklch(0.9700 0 0);
  --muted-foreground: oklch(0.5560 0 0);
  --accent: oklch(0.9700 0 0);
  --accent-foreground: oklch(0.2050 0 0);
  --destructive: oklch(0.5770 0.2450 27.3250);
  --destructive-foreground: oklch(1 0 0);
  --border: oklch(0.9220 0 0);
  --input: oklch(0.9220 0 0);
  --ring: oklch(0.7080 0 0);
  --chart-1: oklch(0.8100 0.1000 252);
  --chart-2: oklch(0.6200 0.1900 260);
  --chart-3: oklch(0.5500 0.2200 263);
  --chart-4: oklch(0.4900 0.2200 264);
  --chart-5: oklch(0.4200 0.1800 266);
  --sidebar: oklch(0.9850 0 0);
  --sidebar-foreground: oklch(0.1450 0 0);
  --sidebar-primary: oklch(0.2050 0 0);
  --sidebar-primary-foreground: oklch(0.9850 0 0);
  --sidebar-accent: oklch(0.9700 0 0);
  --sidebar-accent-foreground: oklch(0.2050 0 0);
  --sidebar-border: oklch(0.9220 0 0);
  --sidebar-ring: oklch(0.7080 0 0);
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --radius: 0.625rem;
  --shadow-2xs: 0 1px 3px 0px hsl(0 0% 0% / 0.05);
  --shadow-xs: 0 1px 3px 0px hsl(0 0% 0% / 0.05);
  --shadow-sm: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 1px 2px -1px hsl(0 0% 0% / 0.10);
  --shadow: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 1px 2px -1px hsl(0 0% 0% / 0.10);
  --shadow-md: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 2px 4px -1px hsl(0 0% 0% / 0.10);
  --shadow-lg: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 4px 6px -1px hsl(0 0% 0% / 0.10);
  --shadow-xl: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 8px 10px -1px hsl(0 0% 0% / 0.10);
  --shadow-2xl: 0 1px 3px 0px hsl(0 0% 0% / 0.25);
  --tracking-normal: 0em;
  --spacing: 0.25rem;

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
</modern-dark-mode-style>

## Images & icons
1. For images, just use pure CSS lines to placeholder images; Don't make up urls
2. For icons, we should use pure CSS lines to placeholder icons

## Workflow
You should always follow workflow below unless user explicitly ask you to do something else:
1. Layout design
2. Theme design (Color, font, spacing, shadown), using generateTheme tool, it should save the css to a local file
3. Generate a singlehtml file for the UI
4. You HAVE TO confirm with user step by step, don't do theme design until user sign off the layout design, same for all follownig steps

### 1. Layout design
Think through how should the layout of interface look like, what are different UI components
And present the layout in ASCII wireframe format, here are the guidelines of good ASCII wireframe, you can do ASCII art too for more custom layout or graphic design

### 2. Theme design
Think through what are the colors, fonts, spacing, etc. 

### 3. Generate html file for each UI component and then combine them together to form a single html file
Generate html file for each UI component and then combine them together to form a single html file
Make sure to reference the theme css file you created in step 2, and add custom ones that doesn't exist yet in html file

<example>
<user>design an AI chat UI</user>

<assistant>
Let's think through the layout design for an AI chat UI. Here are the key components and layout considerations:

## Core UI Components

**Header Area**
- Settings/menu button (Top left)
- Chat title/AI name (Top left)
- Conversation controls (new chat, clear, etc.) (Top right)

**Main Chat Area**
- Message container (scrollable) (Full width & height)
- User messages (typically right-aligned)
- AI messages (typically left-aligned)
- Message timestamps (Small subtle text at the bottom of each message, aligned to the right/left depending on the message)

**Input Area**
- Text input field (Full width left)
- Send button (Embed within the input field,Bottom right side of the screen)
- Additional controls (attach files, voice input, etc.) (Embed within the input field, Bottom left)
- Character/token counter (optional) (Embed within the input field, top right corner, small text)


## Layout Structure Options

┌─────────────────────────────────────┐
│ ☰          HEADER BAR            + │
├─────────────────────────────────────┤
│                                     │
│ ┌─────────────────────────────┐     │
│ │     AI Message Bubble       │     │
│ └─────────────────────────────┘     │
│                                     │
│     ┌─────────────────────────────┐ │
│     │     User Message Bubble     │ │
│     └─────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────┐     │
│ │     AI Message Bubble       │     │
│ └─────────────────────────────┘     │
│                                     │
│              [CHAT AREA]            │
│                                     │
├─────────────────────────────────────┤
│ [Text Input Field]           [Send] │
└─────────────────────────────────────┘

When hamburger (☰) is clicked, sidebar slides out:
┌──────────────┬─────────────────────────────────────┐
│   SIDEBAR    │ ☰           HEADER BAR           + │
│ ┌──────────┐ ├─────────────────────────────────────┤
│ │ Chat 1   │ │                                     │
│ │ Chat 2   │ │ ┌─────────────────────────────┐     │
│ │ Chat 3   │ │ │     AI Message Bubble       │     │
│ │ + New    │ │ └─────────────────────────────┘     │
│ └──────────┘ │                                     │
│              │     ┌─────────────────────────────┐ │
│              │     │     User Message Bubble     │ │
│              │     └─────────────────────────────┘ │
│              │                                     │
│              │ ┌─────────────────────────────┐     │
│              │ │     AI Message Bubble       │     │
│              │ └─────────────────────────────┘     │
│              │                                     │
│              │              [CHAT AREA]            │
│              │                                     │
│              ├─────────────────────────────────────┤
│              │ [Text Input Field]           [Send] │
└──────────────┘─────────────────────────────────────┘

Would you like to go ahead with this layout & UI interaction or needs any modification?
</assistant>

<user>
They looks good
</user>

<assistant>
Great, next let's design the color & font theme,

generateTheme(theme_name='Vercel techy style', reasoning_reference='Reference classic shadcn style that has ...', cssFilePath='design_iterations/theme_1.css', cssSheet=':root {
  --background: oklch(1.0000 0 0);
  --foreground: oklch(0.1448 0 0);
  --card: oklch(1.0000 0 0);
  --card-foreground: oklch(0.1448 0 0);
  --popover: oklch(1.0000 0 0);
  --popover-foreground: oklch(0.1448 0 0);
  --primary: oklch(0.5555 0 0);
  --primary-foreground: oklch(0.9851 0 0);
  --secondary: oklch(0.9702 0 0);
  --secondary-foreground: oklch(0.2046 0 0);
  --muted: oklch(0.9702 0 0);
  --muted-foreground: oklch(0.5486 0 0);
  --accent: oklch(0.9702 0 0);
  --accent-foreground: oklch(0.2046 0 0);
  --destructive: oklch(0.5830 0.2387 28.4765);
  --destructive-foreground: oklch(0.9702 0 0);
  --border: oklch(0.9219 0 0);
  --input: oklch(0.9219 0 0);
  --ring: oklch(0.7090 0 0);
  --chart-1: oklch(0.5555 0 0);
  --chart-2: oklch(0.5555 0 0);
  --chart-3: oklch(0.5555 0 0);
  --chart-4: oklch(0.5555 0 0);
  --chart-5: oklch(0.5555 0 0);
  --sidebar: oklch(0.9851 0 0);
  --sidebar-foreground: oklch(0.1448 0 0);
  --sidebar-primary: oklch(0.2046 0 0);
  --sidebar-primary-foreground: oklch(0.9851 0 0);
  --sidebar-accent: oklch(0.9702 0 0);
  --sidebar-accent-foreground: oklch(0.2046 0 0);
  --sidebar-border: oklch(0.9219 0 0);
  --sidebar-ring: oklch(0.7090 0 0);
  --font-sans: Geist Mono, monospace;
  --font-serif: Geist Mono, monospace;
  --font-mono: Geist Mono, monospace;
  --radius: 0rem;
  --shadow-2xs: 0px 1px 0px 0px hsl(0 0% 0% / 0.00);
  --shadow-xs: 0px 1px 0px 0px hsl(0 0% 0% / 0.00);
  --shadow-sm: 0px 1px 0px 0px hsl(0 0% 0% / 0.00), 0px 1px 2px -1px hsl(0 0% 0% / 0.00);
  --shadow: 0px 1px 0px 0px hsl(0 0% 0% / 0.00), 0px 1px 2px -1px hsl(0 0% 0% / 0.00);
  --shadow-md: 0px 1px 0px 0px hsl(0 0% 0% / 0.00), 0px 2px 4px -1px hsl(0 0% 0% / 0.00);
  --shadow-lg: 0px 1px 0px 0px hsl(0 0% 0% / 0.00), 0px 4px 6px -1px hsl(0 0% 0% / 0.00);
  --shadow-xl: 0px 1px 0px 0px hsl(0 0% 0% / 0.00), 0px 8px 10px -1px hsl(0 0% 0% / 0.00);
  --shadow-2xl: 0px 1px 0px 0px hsl(0 0% 0% / 0.00);
  --tracking-normal: 0em;
  --spacing: 0.25rem;
}')

Do you like the colors? Is there anything that needs to be changed?

<user>
Looks great
</user>

<assistant>
Great, I will generate the html file for each UI component and then combine them together to form a single html file

write(file_path='design_iterations/chat_ui.css', content='...')
write(file_path='design_iterations/chat_ui.html', content='...')

I've created the html design, please reveiw and let me know if you need any changes
</assistant>
</example>


# Available Tools
- **read**: Read file contents within the workspace (supports text files, images, with line range options)
- **write**: Write content to files in the workspace (creates parent directories automatically)
- **edit**: Replace text within files using exact string matching (requires precise text matching including whitespace and indentation)
- **multiedit**: Perform multiple find-and-replace operations on a single file in sequence (each edit applied to result of previous edit)
- **glob**: Find files and directories matching glob patterns (e.g., "*.js", "src/**/*.ts") - efficient for locating files by name or path structure
- **grep**: Search for text patterns within file contents using regular expressions (can filter by file types and paths)
- **ls**: List directory contents with optional filtering, sorting, and detailed information (shows files and subdirectories)
- **bash**: Execute shell/bash commands within the workspace (secure execution with timeouts and output capture)
- **generateTheme**: Generate a theme for the design
`;
    }

    // eslint-disable-next-line @typescript-eslint/member-ordering
    async query(
        conversationHistory: ChatMessage[],
        abortController: AbortController,
        onMessage: (prev: ChatMessage[]) => void
    ): Promise<ChatMessage[]> {
        if (!this.isInitialized) {
            await this.setupWorkingDirectory();
        }

        let updatedMessages: ChatMessage[] = conversationHistory;
        const sessionId = `session_${Date.now()}`;

        try {
            this.logger.info('Starting AI SDK streamText...');

            // Create execution context for tools
            const executionContext: ExecutionContext = {
                workingDirectory: this.workingDirectory,
                sessionId: sessionId,
                logger: getLogger('query context'),
                abortController: abortController,
            };

            // Create tools with context
            const tools = {
                read: createReadTool(executionContext),
                write: createWriteTool(executionContext),
                edit: createEditTool(executionContext),
                multiedit: createMultieditTool(executionContext),
                glob: createGlobTool(executionContext),
                grep: createGrepTool(executionContext),
                ls: createLsTool(executionContext),
                bash: createBashTool(executionContext),
                generateTheme: createThemeTool(executionContext),
            };

            const model: LanguageModelV2 = await getSdkLanguageModel(this.storage);
            const result = streamText({
                model,
                system: this.getSystemPrompt(),
                messages: conversationHistory,
                tools: tools,
                abortSignal: abortController.signal,
            });

            this.logger.info('AI SDK streamText created, starting to process chunks...');

            for await (const chunk of result.fullStream) {
                // Check for abort signal
                if (abortController?.signal.aborted) {
                    this.logger.info('Operation aborted by user');
                    throw new Error('Operation cancelled');
                }

                if (!chunk.type.includes('delta')) {
                    console.log(`Received chunk type: ${chunk.type}`, { chunk });
                }
                switch (chunk.type) {
                    case 'text-delta': {
                        const lastMessage = updatedMessages[updatedMessages.length - 1];

                        if (
                            lastMessage !== undefined &&
                            lastMessage.role === 'assistant' &&
                            typeof lastMessage.content === 'string' &&
                            lastMessage.metadata?.is_error !== true
                        ) {
                            updatedMessages = [
                                ...updatedMessages.slice(0, -1),
                                {
                                    ...lastMessage,
                                    content: lastMessage.content + chunk.text,
                                },
                            ];
                        } else {
                            updatedMessages = [
                                ...updatedMessages,
                                {
                                    role: 'assistant',
                                    content: chunk.text,
                                },
                            ];
                        }

                        break;
                    }
                    case 'finish': {
                        this.logger.info(
                            `===Stream finished with reason: ${chunk.finishReason}`,
                            chunk
                        );
                        break;
                    }
                    case 'error': {
                        const errorMsg = extractErrorMessage(chunk.error);
                        this.logger.error(`Stream error: ${errorMsg}`, { chunk });

                        updatedMessages = [
                            ...updatedMessages,
                            {
                                role: 'assistant',
                                content: errorMsg,
                                metadata: {
                                    is_error: true,
                                    timestamp: Date.now(),
                                    session_id: sessionId,
                                },
                            },
                        ];

                        break;
                    }
                    case 'tool-input-start': {
                        this.logger.info(
                            `Tool call streaming started: ${chunk.toolName} (ID: ${chunk.id})`
                        );

                        // Send initial tool call message in CoreAssistantMessage format
                        updatedMessages = [
                            ...updatedMessages,
                            {
                                role: 'assistant',
                                content: [
                                    {
                                        type: 'tool-call',
                                        toolCallId: chunk.id,
                                        toolName: chunk.toolName,
                                        input: {}, // Empty initially, will be updated with deltas
                                    },
                                ],
                            },
                        ];

                        break;
                    }
                    case 'tool-input-delta': {
                        break;
                    }
                    case 'tool-call': {
                        // Handle final complete tool call - CoreAssistantMessage format
                        this.logger.info(`=====Tool call complete`, { chunk });
                        console.log('Tool call complete', { chunk });
                        // Always try to find and update existing tool call first
                        let toolCallUpdated = false;
                        for (let i = updatedMessages.length - 1; i >= 0; i--) {
                            let msg = updatedMessages[i];
                            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                                const toolCallIndex = msg.content.findIndex(
                                    (
                                        part:
                                            | TextPart
                                            | FilePart
                                            | ReasoningPart
                                            | ToolCallPart
                                            | ToolResultPart
                                    ) =>
                                        part.type === 'tool-call' &&
                                        part.toolCallId === chunk.toolCallId
                                );
                                if (toolCallIndex !== -1) {
                                    const content = [...msg.content];
                                    content[toolCallIndex] = {
                                        type: 'tool-call',
                                        toolCallId: chunk.toolCallId,
                                        toolName: chunk.toolName,
                                        input: chunk.input,
                                    };
                                    this.logger.info(
                                        `Updated tool call with final parameters for ID: ${chunk.toolCallId}`
                                    );
                                    toolCallUpdated = true;
                                    msg = {
                                        ...msg,
                                        content,
                                    };
                                    updatedMessages[i] = msg;
                                    break;
                                }
                            }
                        }

                        // Only create new message if we didn't find an existing one to update
                        if (!toolCallUpdated) {
                            updatedMessages = [
                                ...updatedMessages,
                                {
                                    role: 'assistant',
                                    content: [
                                        {
                                            type: 'tool-call',
                                            toolCallId: chunk.toolCallId,
                                            toolName: chunk.toolName,
                                            input: chunk.input,
                                        },
                                    ],
                                },
                            ];
                        }

                        break;
                    }
                    case 'file': {
                        console.warn('File:', chunk);
                        break;
                    }
                    case 'abort': {
                        console.warn('Abort:', chunk);
                        break;
                    }
                    case 'source': {
                        console.warn('Source:', chunk);
                        break;
                    }
                    case 'tool-result': {
                        console.log('Tool result:', chunk);
                        updatedMessages = [
                            ...updatedMessages,
                            {
                                role: 'tool',
                                content: [
                                    {
                                        type: 'tool-result',
                                        toolCallId: chunk.toolCallId,
                                        toolName: chunk.toolName,
                                        output: guessToolResultOutput(chunk.output),
                                    },
                                ],
                            },
                        ];
                        break;
                    }
                    case 'tool-error': {
                        console.error('Tool error:', chunk);
                        updatedMessages = [
                            ...updatedMessages,
                            {
                                role: 'tool',
                                content: [
                                    {
                                        type: 'tool-result',
                                        toolCallId: chunk.toolCallId,
                                        toolName: chunk.toolName,
                                        output: guessToolResultOutput(chunk.error),
                                    },
                                ],
                                metadata: {
                                    is_error: true,
                                },
                            },
                        ];
                        break;
                    }
                    case 'text-start':
                    case 'text-end':
                    case 'start-step':
                    case 'finish-step':
                    case 'start':
                    case 'tool-input-end':
                    case 'reasoning-start':
                    case 'reasoning-end':
                    case 'reasoning-delta':
                    case 'raw': {
                    }
                }
                onMessage(updatedMessages);
            }

            this.logger.info(
                `Query completed. New messages: ${updatedMessages.length - conversationHistory.length}`
            );

            return updatedMessages;
        } catch (error) {
            const errorMsg = extractErrorMessage(error);
            this.logger.error(`Custom Agent query failed`, { error });
            console.error(`Custom Agent query failed`, { error });

            updatedMessages = [
                ...updatedMessages,
                {
                    role: 'assistant',
                    content: errorMsg,
                    metadata: {
                        is_error: true,
                        timestamp: Date.now(),
                        session_id: sessionId,
                    },
                },
            ];

            onMessage(updatedMessages);

            throw error;
        }
    }

    get isReady(): boolean {
        return this.isInitialized;
    }

    async waitForInitialization(): Promise<boolean> {
        if (!this.isInitialized) {
            await this.setupWorkingDirectory();
        }
        return this.isInitialized;
    }

    getWorkingDirectory(): string {
        return this.workingDirectory;
    }

    isApiKeyAuthError(errorMessage: string): boolean {
        if (!errorMessage) {
            return false;
        }

        const lowerError = errorMessage.toLowerCase();
        return (
            lowerError.includes('api key') ||
            lowerError.includes('authentication') ||
            lowerError.includes('unauthorized') ||
            lowerError.includes('invalid_api_key') ||
            lowerError.includes('permission_denied') ||
            lowerError.includes('api_key_invalid') ||
            lowerError.includes('unauthenticated')
        );
    }
}
