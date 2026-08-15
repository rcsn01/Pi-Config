import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../_shared/subagent-service.ts";

export interface AgentRegistry {
	initialize(): void;
	register(config: AgentConfig): void;
	unregister(name: string): void;
	load(): AgentConfig[];
	resolve(agent: string | AgentConfig): AgentConfig;
}

export function createAgentRegistry(agentsDir: string): AgentRegistry {
	let registeredAgents: AgentConfig[] = [];

	function discover(): AgentConfig[] {
		const discovered: AgentConfig[] = [];
		if (!fs.existsSync(agentsDir)) return discovered;
		for (const entry of fs.readdirSync(agentsDir)) {
			if (!entry.endsWith(".md")) continue;
			const filePath = path.join(agentsDir, entry);
			const content = fs.readFileSync(filePath, "utf-8");
			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
			if (!frontmatter.name) continue;
			const tools = (frontmatter.tools || "")
				.split(",")
				.map((tool) => tool.trim())
				.filter(Boolean);
			discovered.push({
				name: frontmatter.name,
				description: frontmatter.description || "",
				tools,
				model: frontmatter.model?.trim() || "",
				systemPrompt: body,
				filePath,
			});
		}
		return discovered;
	}

	function load(): AgentConfig[] {
		const byName = new Map<string, AgentConfig>();
		for (const agent of discover()) byName.set(agent.name, agent);
		for (const agent of registeredAgents) byName.set(agent.name, agent);
		return [...byName.values()];
	}

	return {
		initialize() {
			registeredAgents = load();
		},
		register(config) {
			if (registeredAgents.find((agent) => agent.name === config.name)) {
				throw new Error(`Agent already registered: ${config.name}`);
			}
			registeredAgents.push(config);
		},
		unregister(name) {
			registeredAgents = registeredAgents.filter((agent) => agent.name !== name);
		},
		load,
		resolve(agent) {
			if (typeof agent !== "string") return agent;
			const availableAgents = load();
			const found = availableAgents.find((candidate) => candidate.name === agent);
			if (!found) {
				throw new Error(`Unknown agent: ${agent}. Available agents: ${availableAgents.map((candidate) => candidate.name).join(", ") || "none"}`);
			}
			return found;
		},
	};
}

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const agentRegistry = createAgentRegistry(path.join(EXT_DIR, "agents"));

export function registerAgent(config: AgentConfig): void {
	agentRegistry.register(config);
}

export function unregisterAgent(name: string): void {
	agentRegistry.unregister(name);
}

export function loadAgents(): AgentConfig[] {
	return agentRegistry.load();
}
