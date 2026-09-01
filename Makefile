SHELL := /bin/zsh
.DEFAULT_GOAL := help

.PHONY: help install typecheck test lint build check push status
help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "%-14s %s\n", $$1, $$2}'
install: ## Install Bun dependencies
	bun install
typecheck: ## Run strict TypeScript checking
	bun run typecheck
test: ## Run lifecycle tests
	bun test
lint: ## Lint and verify formatting
	bun run lint
build: ## Build distributable plugin
	bun run build
check: typecheck lint test build ## Run all project checks
push: ## Push the current branch to GitHub and GitLab
	@branch="$$(git branch --show-current)"; for remote in github gitlab; do git push "$$remote" "$$branch"; done
status: ## Show repository status
	@git status --short --branch
