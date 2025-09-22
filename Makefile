# Conditionally include .env or .env.automation based on OPS_LAUNCH_MODE
ifeq ($(OPS_LAUNCH_MODE),auto)
-include .env.automation
else
-include .env
endif
export

OPS_NETWORK := $(subst ",,$(OPS_NETWORK))
OPS_CHAIN_ID := $(subst ",,$(OPS_CHAIN_ID))
OPS_KYC_TOKEN_SUFFIX := $(subst ",,$(OPS_KYC_TOKEN_SUFFIX))

CURRENT_DIR := $(shell pwd)

FILE_DEPLOY_KYC_NFT := $(CURRENT_DIR)/deploy/deploy-kyc-nft.js
FILE_CREATE3_DEPLOYER := $(CURRENT_DIR)/deploy/constants/create3-deployer.js
FILE_ACCESS_TOKEN_OWNER := $(CURRENT_DIR)/deploy/constants/access-token-owner.js
FILE_ACCESS_TOKEN_SALT := $(CURRENT_DIR)/deploy/constants/access-token-salt.js

# New access token deployment targets
deploy-access-token:
		@$(MAKE) OPS_CURRENT_DEP_FILE=$(FILE_DEPLOY_KYC_NFT) validate-access-token deploy-skip-all deploy-noskip deploy-access-token-impl deploy-skip

deploy-access-token-impl:
		@{ \
		yarn deploy $(OPS_NETWORK) || exit 1; \
		}

# Validation targets
validate-access-token:
		@{ \
		if [ -z "$(OPS_NETWORK)" ]; then echo "OPS_NETWORK is not set!"; exit 1; fi; \
		if [ -z "$(OPS_CHAIN_ID)" ]; then echo "OPS_CHAIN_ID is not set!"; exit 1; fi; \
		if [ -z "$(OPS_CREATE3_DEPLOYER_ADDRESS)" ] && [ "$(OPS_CHAIN_ID)" != 324 ]; then echo "OPS_CREATE3_DEPLOYER_ADDRESS is not set!"; exit 1; fi; \
		if [ -z "$(MAINNET_RPC_URL)" ] && [ "$(OPS_NETWORK)" = "hardhat" ]; then echo "MAINNET_RPC_URL is not set!"; exit 1; fi; \
		if [ -z "$(OPS_KYC_TOKEN_OWNER_ADDRESS)" ]; then echo "OPS_KYC_TOKEN_OWNER_ADDRESS is not set!"; exit 1; fi; \
		if [ -z "$(OPS_KYC_TOKEN_SALT)" ]; then echo "OPS_KYC_TOKEN_SALT is not set!"; exit 1; fi; \
		$(MAKE) process-access-token-owner process-access-token-salt process-create3-deployer; \
		}

# Process constant functions for new addresses
process-access-token-owner:
		@$(MAKE) OPS_GEN_VAL='$(OPS_KYC_TOKEN_OWNER_ADDRESS)' OPS_GEN_FILE=$(FILE_ACCESS_TOKEN_OWNER) upsert-constant

process-access-token-salt:
		@$(MAKE) OPS_GEN_VAL='$(OPS_KYC_TOKEN_SALT)' OPS_GEN_FILE=$(FILE_ACCESS_TOKEN_SALT) upsert-constant

process-create3-deployer:
		@{ \
		if [ -n "$(OPS_CREATE3_DEPLOYER_ADDRESS)" ]; then \
			$(MAKE) OPS_GEN_VAL='$(OPS_CREATE3_DEPLOYER_ADDRESS)' OPS_GEN_FILE=$(FILE_CREATE3_DEPLOYER) upsert-constant; \
		fi \
		}

upsert-constant:
		@{ \
		if [ -z "$(OPS_GEN_VAL)" ]; then \
			echo "variable for file $(OPS_GEN_FILE) is not set!"; \
			exit 1; \
		fi; \
		if grep -q "$(OPS_CHAIN_ID)" $(OPS_GEN_FILE); then \
			sed -i '' 's|$(OPS_CHAIN_ID): .*|$(OPS_CHAIN_ID): $(OPS_GEN_VAL),|' $(OPS_GEN_FILE); \
			sed -i '' 's/"/'\''/g' $(OPS_GEN_FILE); \
		else \
			tmpfile=$$(mktemp); \
			awk '1;/module.exports = {/{print "    $(OPS_CHAIN_ID): $(subst ",\",$(OPS_GEN_VAL)),"}' $(OPS_GEN_FILE) > $$tmpfile && sed -i '' 's/"/'\''/g' $$tmpfile && mv $$tmpfile $(OPS_GEN_FILE); \
		fi \
		}

deploy-skip-all:
		@{ \
		for secret in $(FILE_DEPLOY_KYC_NFT); do \
			$(MAKE) OPS_CURRENT_DEP_FILE=$$secret deploy-skip; \
		done \
		}

deploy-skip:
		@sed -i '' 's/module.exports.skip.*/module.exports.skip = async () => true;/g' $(OPS_CURRENT_DEP_FILE)

deploy-noskip:
		@sed -i '' 's/module.exports.skip.*/module.exports.skip = async () => false;/g' $(OPS_CURRENT_DEP_FILE)

launch-hh-node:
		@{ \
		if [ -z "$(NODE_RPC)" ]; then \
			echo "NODE_RPC is not set!"; \
			exit 1; \
		fi; \
		echo "Launching Hardhat node with RPC: $(NODE_RPC)"; \
		npx hardhat node --fork $(NODE_RPC) --vvvv --full-trace; \
		}

install: install-utils install-dependencies

install-utils:
		brew install yarn wget

install-dependencies:
		yarn

clean:
		@rm -Rf $(CURRENT_DIR)/deployments/$(OPS_NETWORK)/*


# Get deployed contract addresses from deployment files
get:
		@{ \
		if [ -z "$(PARAMETER)" ]; then \
			echo "Error: PARAMETER is not set. Usage: make get PARAMETER=OPS_AGGREGATION_EXECUTOR_SIMPLE_ADDRESS"; \
			exit 1; \
		fi; \
		if [ -z "$(OPS_NETWORK)" ]; then \
			echo "Error: OPS_NETWORK is not set"; \
			exit 1; \
		fi; \
		CONTRACT_FILE=""; \
		case "$(PARAMETER)" in \
			"OPS_KYC_TOKEN_ADDRESS") CONTRACT_FILE="KycNFT.json" ;; \
			*) echo "Error: Unknown parameter $(PARAMETER)"; exit 1 ;; \
		esac; \
		DEPLOYMENT_FILE="$(CURRENT_DIR)/deployments/$(OPS_NETWORK)/$$CONTRACT_FILE"; \
		if [ ! -f "$$DEPLOYMENT_FILE" ]; then \
			echo "Error: Deployment file $$DEPLOYMENT_FILE not found"; \
			exit 1; \
		fi; \
		ADDRESS=$$(cat "$$DEPLOYMENT_FILE" | grep '"address"' | head -1 | sed 's/.*"address": *"\([^"]*\)".*/\1/'); \
		echo "$$ADDRESS"; \
		}

help:
	@echo "Available targets:"
	@echo "  deploy-access-token         Deploy access token contracts"
	@echo "  deploy-access-token-impl    Deploy access token implementation"
	@echo "  validate-access-token       Validate required environment variables"
	@echo "  process-access-token-owner  Update access token owner constant"
	@echo "  process-access-token-salt   Update access token salt constant"
	@echo "  process-create3-deployer    Update create3 deployer constant"
	@echo "  upsert-constant            Upsert constant value in JS file"
	@echo "  deploy-skip-all            Mark all deploy files as skipped"
	@echo "  deploy-skip                Mark current deploy file as skipped"
	@echo "  deploy-noskip              Mark current deploy file as not skipped"
	@echo "  launch-hh-node             Launch Hardhat node with forked RPC"
	@echo "  install                    Install utils and dependencies"
	@echo "  install-utils              Install required utilities"
	@echo "  install-dependencies       Install yarn dependencies"
	@echo "  clean                      Remove deployment files"
	@echo "  get PARAMETER=...          Get deployed contract address"
	@echo "  help                       Show this help message"


.PHONY: help deploy-access-token deploy-access-token-impl validate-access-token process-access-token-owner process-access-token-salt process-create3-deployer upsert-constant deploy-skip-all deploy-skip deploy-noskip launch-hh-node install install-utils install-dependencies clean get
