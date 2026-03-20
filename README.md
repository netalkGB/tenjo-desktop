# Tenjo Desktop

A desktop AI chat app with support for multiple providers (LM Studio, Ollama) and MCP (Model Context Protocol).

## FAQ

**How do I connect to an AI provider?**
Open the settings page and add a provider endpoint.

**Images in prompts are not working.**
The connected model must support vision. Use a vision-capable model if you want to include images in prompts.

**MCP tools are not working.**
The connected model must support function calling. MCP tool calling will not work with models that do not support it. Even with supported models, tool calls may not work well depending on the model's capability.

## License

[MIT](LICENSE) &copy; netalkGB
