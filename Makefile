# Switchyard (Dokploy + Claude Code) launch commands
#
#   make up       Launch Dokploy (Docker daemon, Swarm, services, Traefik)
#   make status   Show the status of the Dokploy stack + dashboard URL
#   make down     Stop the Dokploy stack (add PURGE=1 to wipe data)
#   make claude   Launch Claude Code in this repo
#   make doctor   Check that prerequisites for both tools are present
#
#   One-command alternative (also registers the admin and runs the dashboard
#   container, works on Windows/macOS too):  npx switchyard-cli up

SHELL := /bin/bash

.PHONY: up status down claude doctor help

help:
	@grep -E '^#   (make|One-command|container)' Makefile | sed 's/^#   //'

up:
	sudo bash scripts/dokploy-up.sh

status:
	sudo bash scripts/dokploy-status.sh

down:
ifeq ($(PURGE),1)
	sudo bash scripts/dokploy-down.sh --purge
else
	sudo bash scripts/dokploy-down.sh
endif

claude:
	bash scripts/claude-up.sh

doctor:
	bash scripts/doctor.sh
