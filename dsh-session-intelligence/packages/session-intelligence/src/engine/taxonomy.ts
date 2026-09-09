/**
 * Tool-name → category taxonomy for session-signal inputs.
 *
 * Ported from agentsview (MIT, Kenn Software) `internal/parser/taxonomy.go`
 * (`NormalizeToolCategory`), which normalizes the tool names of many agent
 * products onto one small category set. The mapping is case-sensitive and
 * exact — unknown names fall back to `Other`, unless they mention
 * `subagent`, which is always a `Task`.
 *
 * @module @hy-sde-org/dsh-session-intelligence/engine/taxonomy
 */

import type { ToolCategory } from './types.ts'

/**
 * Map a raw tool name to a normalized category.
 * @param rawName - the tool name as recorded in a `tool/call` event.
 * @returns one of the {@link ToolCategory} values.
 */
export function normalizeToolCategory(rawName: string): ToolCategory {
  switch (rawName) {
    // Claude Code tools
    case 'Read':
      return 'Read'
    case 'Edit':
      return 'Edit'
    case 'Write':
    case 'NotebookEdit':
      return 'Write'
    case 'Bash':
      return 'Bash'
    case 'Grep':
      return 'Grep'
    case 'Glob':
      return 'Glob'
    case 'Task':
    case 'Agent':
      return 'Task'
    case 'Skill':
      return 'Tool'

    // Codex tools
    case 'shell_command':
    case 'exec_command':
    case 'write_stdin':
    case 'shell':
      return 'Bash'
    case 'list_files':
      return 'Read'
    case 'apply_patch':
      return 'Edit'
    case 'spawn_agent':
      return 'Task'

    // Gemini tools
    case 'read_file':
    case 'list_directory':
      return 'Read'
    case 'write_file':
      return 'Write'
    case 'edit_file':
    case 'replace':
      return 'Edit'
    case 'run_command':
    case 'execute_command':
    case 'run_shell_command':
      return 'Bash'
    case 'search_files':
    case 'grep':
    case 'grep_search':
      return 'Grep'

    // Kilo (legacy) / RooCode (Cline-family) camelCase tool names
    case 'appliedDiff':
    case 'searchAndReplace':
    case 'editedExistingFile':
    case 'deleteFile':
      return 'Edit'
    case 'insertContent':
      return 'Write'
    case 'readFile':
    case 'listFiles':
    case 'listCodeDefinitionNames':
    case 'listFilesTopLevel':
    case 'listFilesRecursive':
      return 'Read'
    case 'searchFiles':
    case 'codebaseSearch':
      return 'Grep'
    case 'writeToFile':
    case 'createFile':
    case 'newFileCreated':
      return 'Write'
    case 'executeCommand':
      return 'Bash'
    case 'useMcpTool':
    case 'use_mcp_tool':
    case 'search':
      return 'Tool'
    case 'newTask':
      return 'Task'
    case 'fetchInstructions':
    case 'updateTodoList':
    case 'finishTask':
    case 'switchMode':
      return 'Tool'

    // Antigravity tools
    case 'view_file':
    case 'read_url_content':
      return 'Read'
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return 'Edit'
    case 'write_to_file':
      return 'Write'
    case 'define_subagent':
    case 'invoke_subagent':
    case 'manage_subagents':
    case 'send_message':
    case 'manage_task':
      return 'Task'
    case 'ask_permission':
    case 'ask_question':
    case 'schedule':
    case 'search_web':
    case 'generate_image':
      return 'Tool'

    // OpenCode tools (lowercase variants)
    case 'read':
      return 'Read'
    case 'edit':
      return 'Edit'
    case 'write':
      return 'Write'
    case 'bash':
      return 'Bash'
    case 'glob':
      return 'Glob'
    case 'task':
      return 'Task'

    // Copilot tools
    case 'view':
      return 'Read'
    case 'report_intent':
      return 'Tool'

    // Cursor tools
    case 'ApplyPatch':
      return 'Edit'
    case 'Shell':
      return 'Bash'
    case 'StrReplace':
      return 'Edit'
    case 'LS':
      return 'Read'

    // Amp tools (not already covered above)
    case 'create_file':
      return 'Write'
    case 'look_at':
      return 'Read'
    case 'undo_edit':
      return 'Edit'
    case 'finder':
      return 'Grep'
    case 'read_web_page':
      return 'Read'
    case 'skill':
      return 'Tool'

    // Pi tools (not already covered above)
    case 'find':
      return 'Read'
    case 'str_replace':
      return 'Edit'

    // OpenClaw tools
    case 'exec':
      return 'Bash'
    case 'process':
      return 'Bash'
    case 'browser':
    case 'web_search':
    case 'web_fetch':
      return 'Tool'
    case 'image':
    case 'canvas':
    case 'tts':
      return 'Tool'
    case 'message':
    case 'nodes':
      return 'Tool'
    case 'sessions_list':
    case 'sessions_history':
    case 'sessions_send':
    case 'sessions_spawn':
      return 'Task'
    case 'subagents':
    case 'agents_list':
    case 'session_status':
      return 'Task'

    // Forge tools
    case 'fs_search':
      return 'Grep'
    case 'patch':
    case 'multi_patch':
    case 'undo':
    case 'remove':
      return 'Edit'
    case 'fetch':
      return 'Read'
    case 'todo_write':
    case 'todo_read':
      return 'Tool'
    case 'parallel':
      return 'Task'

    // Hermes Agent tools (excluding names handled above)
    case 'terminal':
      return 'Bash'
    case 'browser_navigate':
    case 'browser_snapshot':
    case 'browser_click':
    case 'browser_type':
    case 'browser_scroll':
    case 'browser_press':
    case 'browser_back':
    case 'browser_close':
    case 'browser_vision':
    case 'browser_console':
    case 'browser_get_images':
      return 'Tool'
    case 'vision_analyze':
      return 'Read'
    case 'delegate_task':
      return 'Task'
    case 'execute_code':
      return 'Bash'
    case 'todo':
    case 'memory':
    case 'session_search':
    case 'skill_view':
    case 'skills_list':
    case 'skill_manage':
    case 'clarify':
    case 'text_to_speech':
    case 'cronjob':
      return 'Tool'

    // Piebald / Piebald-hosted built-in tools (not already covered above)
    case 'ReadFile':
      return 'Read'
    case 'WriteFile':
      return 'Write'
    case 'EditFile':
      return 'Edit'
    case 'RunTerminalCommand':
      return 'Bash'
    case 'LaunchSubagent':
      return 'Task'
    case 'WebFetch':
    case 'WebSearch':
      return 'Tool'
    case 'TodoWrite':
    case 'AskUserQuestion':
    case 'ProposePlanToUser':
      return 'Tool'

    // Zencoder tools (not already covered above)
    case 'subagent__ZencoderSubagent':
      return 'Task'
    case 'zencoder-rag-mcp__web_search':
      return 'Read'

    // Codebuff / Freebuff tools
    case 'read_subtree':
    case 'file-picker':
      return 'Read'
    case 'suggest_followups':
    case 'write_todos':
    case 'read_url':
    case 'ask_user':
    case 'render_ui':
    case 'gravity_index':
      return 'Tool'
    case 'run_terminal_command':
    case 'basher':
      return 'Bash'
    case 'code-searcher':
    case 'code-reviewer':
      return 'Tool'
    case 'spawn_agents':
      return 'Task'

    // ChatGPT tools
    case 'code_interpreter':
      return 'Bash'

    // Shelley (exe.dev) tools (excluding names handled above)
    case 'keyword_search':
      return 'Grep'
    case 'read_context_file':
    case 'read_image':
      return 'Read'
    case 'change_dir':
    case 'output_iframe':
    case 'llm_one_shot':
    case 'browser_emulate':
    case 'browser_network':
    case 'browser_accessibility':
    case 'browser_profile':
      return 'Tool'

    // Posit Assistant tools (excluding names handled above)
    case 'ls':
    case 'getConsoleContent':
      return 'Read'
    case 'runCode':
    case 'executeCode':
      return 'Bash'
    case 'todoWrite':
    case 'webfetch':
    case 'EnterMode':
    case 'ExitMode':
      return 'Tool'
    case 'explore':
      return 'Task'

    // Warp tools
    case 'read_files':
      return 'Read'
    case 'apply_file_diff':
      return 'Edit'
    case 'search_codebase':
      return 'Grep'
    case 'call_mcp_tool':
    case 'read_mcp_resource':
      return 'Tool'
    case 'suggest_plan':
    case 'suggest_create_plan':
      return 'Tool'
    case 'write_to_long_running_shell_command':
      return 'Bash'
    case 'read_shell_command_output':
      return 'Read'
    case 'use_computer':
      return 'Tool'

    // Poolside tools (only tools not already covered above)
    case 'todo_action':
    case 'switch_mode':
    case 'question':
    case 'exit':
      return 'Tool'
    case 'shell_kill':
    case 'shell_status':
    case 'shell_tail':
      return 'Bash'

    default:
      // MCP tools may carry a server prefix or use spawn_subagent naming.
      if (rawName.includes('subagent')) {
        return 'Task'
      }
      return 'Other'
  }
}
