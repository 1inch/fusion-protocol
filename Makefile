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
OPS_DEPLOYMENT_METHOD := $(subst ",,$(OPS_DEPLOYMENT_METHOD))

CURRENT_DIR := $(shell pwd)

FILE_DEPLOY_KYC_NFT := $(CURRENT_DIR)/deploy/deploy-kyc-nft.js
FILE_DEPLOY_SETTLEMENT := $(CURRENT_DIR)/deploy/deploy-settlement.js
FILE_DEPLOY_POWER_POD := $(CURRENT_DIR)/deploy/deploy-power-pod.js
FILE_DEPLOY_WHITELIST_REGISTRY := $(CURRENT_DIR)/deploy/deploy-whitelist-registry.js
FILE_DEPLOY_CROSSCHAIN_WHITELIST := $(CURRENT_DIR)/deploy/deploy-crosschain-whitelist.js
FILE_DEPLOY_RESOLVER_METADATA := $(CURRENT_DIR)/deploy/deploy-resolver-metadata.js
FILE_CONSTANTS_JSON := $(CURRENT_DIR)/config/constants.json

ALL_DEPLOY_FILES := $(FILE_DEPLOY_KYC_NFT) $(FILE_DEPLOY_SETTLEMENT) $(FILE_DEPLOY_POWER_POD) $(FILE_DEPLOY_WHITELIST_REGISTRY) $(FILE_DEPLOY_CROSSCHAIN_WHITELIST) $(FILE_DEPLOY_RESOLVER_METADATA)

IS_ZKSYNC := $(findstring zksync,$(OPS_NETWORK))

# Deployment targets
deploy-access-token:
		@$(MAKE) OPS_CURRENT_DEP_FILE=$(FILE_DEPLOY_KYC_NFT) validate-access-token deploy-skip-all deploy-noskip deploy-impl deploy-skip

deploy-settlement:
		@$(MAKE) OPS_CURRENT_DEP_FILE=$(FILE_DEPLOY_SETTLEMENT) validate-settlement deploy-skip-all deploy-noskip deploy-impl deploy-skip

deploy-power-pod:
		@$(MAKE) OPS_CURRENT_DEP_FILE=$(FILE_DEPLOY_POWER_POD) validate-power-pod deploy-skip-all deploy-noskip deploy-impl deploy-skip

deploy-whitelist-registry:
		@$(MAKE) OPS_CURRENT_DEP_FILE=$(FILE_DEPLOY_WHITELIST_REGISTRY) validate-whitelist-registry deploy-skip-all deploy-noskip deploy-impl deploy-skip

deploy-crosschain-whitelist:
		@$(MAKE) OPS_CURRENT_DEP_FILE=$(FILE_DEPLOY_CROSSCHAIN_WHITELIST) validate-crosschain-whitelist deploy-skip-all deploy-noskip deploy-impl deploy-skip

deploy-resolver-metadata:
		@$(MAKE) OPS_CURRENT_DEP_FILE=$(FILE_DEPLOY_RESOLVER_METADATA) validate-resolver-metadata deploy-skip-all deploy-noskip deploy-impl deploy-skip

deploy-impl:
		@{ \
		yarn deploy $(OPS_NETWORK) || exit 1; \
		}

# Validation targets
validate-base:
		@{ \
		$(MAKE) ID=OPS_NETWORK validate || exit 1; \
		$(MAKE) ID=OPS_CHAIN_ID validate || exit 1; \
		if [ "$(OPS_NETWORK)" = "hardhat" ]; then \
			$(MAKE) ID=MAINNET_RPC_URL validate || exit 1; \
		fi; \
		}

validate-access-token:
		@{ \
		$(MAKE) validate-base || exit 1; \
		if [ "$(IS_ZKSYNC)" = "" ]; then \
			$(MAKE) ID=OPS_CREATE3_DEPLOYER_ADDRESS validate || exit 1; \
			$(MAKE) ID=OPS_KYC_TOKEN_SALT validate || exit 1; \
		fi; \
        $(MAKE) ID=OPS_KYC_TOKEN_OWNER_ADDRESS validate || exit 1; \
        $(MAKE) process-access-token-owner process-access-token-salt process-create3-deployer || exit 1; \
        }

validate-settlement:
		@{ \
		$(MAKE) validate-base || exit 1; \
		$(MAKE) ID=OPS_ROUTER_V6_ADDRESS validate || exit 1; \
		$(MAKE) ID=OPS_ACCESS_TOKEN_ADDRESS validate || exit 1; \
		$(MAKE) ID=OPS_WETH_ADDRESS validate || exit 1; \
		$(MAKE) ID=OPS_SETTLEMENT_OWNER_ADDRESS validate || exit 1; \
		if [ "$(IS_ZKSYNC)" = "" ] && [ "$(OPS_DEPLOYMENT_METHOD)" != "create" ]; then \
			$(MAKE) ID=OPS_CREATE3_DEPLOYER_ADDRESS validate || exit 1; \
			$(MAKE) ID=OPS_SETTLEMENT_SALT validate || exit 1; \
		fi; \
		$(MAKE) process-router-v6 process-access-token-address process-weth process-settlement-owner process-settlement-salt process-create3-deployer || exit 1; \
		}

validate-power-pod:
		@{ \
		$(MAKE) validate-base || exit 1; \
		$(MAKE) ID=OPS_ST1INCH_ADDRESS validate || exit 1; \
		$(MAKE) process-st1inch || exit 1; \
		}

validate-whitelist-registry:
		@{ \
		$(MAKE) validate-base || exit 1; \
		$(MAKE) ID=OPS_POWER_POD_ADDRESS validate || exit 1; \
		$(MAKE) ID=OPS_DAO_ADDRESS validate || exit 1; \
		$(MAKE) process-power-pod process-dao || exit 1; \
		}

validate-crosschain-whitelist:
		@{ \
		$(MAKE) validate-base || exit 1; \
		$(MAKE) ID=OPS_WHITELIST_REGISTRY_ADDRESS validate || exit 1; \
		$(MAKE) ID=OPS_DAO_ADDRESS validate || exit 1; \
		$(MAKE) process-whitelist-registry process-dao || exit 1; \
		}

validate-resolver-metadata:
		@{ \
		$(MAKE) validate-base || exit 1; \
		$(MAKE) ID=OPS_POWER_POD_ADDRESS validate || exit 1; \
		$(MAKE) process-power-pod || exit 1; \
		}

# Process constant functions
process-access-token-owner:
		@$(MAKE) OPS_GEN_KEY='accessTokenOwner' OPS_GEN_VAL='$(OPS_KYC_TOKEN_OWNER_ADDRESS)' upsert-constant

process-access-token-salt:
		@$(MAKE) OPS_GEN_KEY='accessTokenSalt' OPS_GEN_VAL='$(OPS_KYC_TOKEN_SALT)' upsert-constant

process-access-token-address:
		@$(MAKE) OPS_GEN_KEY='accessTokenAddress' OPS_GEN_VAL='$(OPS_ACCESS_TOKEN_ADDRESS)' upsert-constant

process-router-v6:
		@$(MAKE) OPS_GEN_KEY='routerV6Address' OPS_GEN_VAL='$(OPS_ROUTER_V6_ADDRESS)' upsert-constant

process-weth:
		@$(MAKE) OPS_GEN_KEY='weth' OPS_GEN_VAL='$(OPS_WETH_ADDRESS)' upsert-constant

process-st1inch:
		@$(MAKE) OPS_GEN_KEY='st1inchAddr' OPS_GEN_VAL='$(OPS_ST1INCH_ADDRESS)' upsert-constant

process-power-pod:
		@$(MAKE) OPS_GEN_KEY='powerPodAddress' OPS_GEN_VAL='$(OPS_POWER_POD_ADDRESS)' upsert-constant

process-dao:
		@$(MAKE) OPS_GEN_KEY='daoAddress' OPS_GEN_VAL='$(OPS_DAO_ADDRESS)' upsert-constant

process-whitelist-registry:
		@$(MAKE) OPS_GEN_KEY='whitelistRegistryAddress' OPS_GEN_VAL='$(OPS_WHITELIST_REGISTRY_ADDRESS)' upsert-constant

process-settlement-owner:
		@$(MAKE) OPS_GEN_KEY='settlementOwnerAddress' OPS_GEN_VAL='$(OPS_SETTLEMENT_OWNER_ADDRESS)' upsert-constant

process-settlement-salt:
		@{ \
		if [ -n "$$OPS_FEE_TAKER_SALT" ]; then \
			$(MAKE) OPS_GEN_KEY='settlementSalt' OPS_GEN_VAL='$(OPS_SETTLEMENT_SALT)' upsert-constant; \
		fi \
		}

process-create3-deployer:
		@{ \
		if [ -n "$$OPS_CREATE3_DEPLOYER_ADDRESS" ]; then \
			$(MAKE) OPS_GEN_KEY='create3Deployers' OPS_GEN_VAL='$(OPS_CREATE3_DEPLOYER_ADDRESS)' upsert-constant; \
		fi \
		}

upsert-constant:
		@{ \
		$(MAKE) ID=OPS_GEN_VAL validate || exit 1; \
		$(MAKE) ID=OPS_GEN_KEY validate || exit 1; \
		$(MAKE) ID=OPS_CHAIN_ID validate || exit 1; \
		tmpfile=$$(mktemp); \
		if echo '$(OPS_GEN_VAL)' | jq type >/dev/null 2>&1; then \
			jq --argjson val '$(OPS_GEN_VAL)' '.$(OPS_GEN_KEY)."$(OPS_CHAIN_ID)" = $$val' $(FILE_CONSTANTS_JSON) > $$tmpfile; \
		else \
			jq --arg val '$(OPS_GEN_VAL)' '.$(OPS_GEN_KEY)."$(OPS_CHAIN_ID)" = $$val' $(FILE_CONSTANTS_JSON) > $$tmpfile; \
		fi && mv $$tmpfile $(FILE_CONSTANTS_JSON); \
		echo "Updated $(OPS_GEN_KEY)[$(OPS_CHAIN_ID)] = $(OPS_GEN_VAL)"; \
		}

deploy-skip-all:
		@{ \
		for secret in $(ALL_DEPLOY_FILES); do \
			$(MAKE) OPS_CURRENT_DEP_FILE=$$secret deploy-skip; \
		done \
		}

deploy-skip:
		@sed -i '' 's/module.exports.skip.*/module.exports.skip = async () => true;/g' $(OPS_CURRENT_DEP_FILE)

deploy-noskip:
		@sed -i '' 's/module.exports.skip.*/module.exports.skip = async () => false;/g' $(OPS_CURRENT_DEP_FILE)

install: install-utils install-dependencies

install-utils:
		brew install yarn wget jq

install-dependencies:
		yarn

clean:
		@rm -Rf $(CURRENT_DIR)/deployments/$(OPS_NETWORK)/*


get:
		@{ \
		$(MAKE) ID=PARAMETER validate || exit 1; \
		$(MAKE) ID=OPS_NETWORK validate || exit 1; \
		if [ ! -d "$(CURRENT_DIR)/deployments/$(OPS_NETWORK)" ]; then \
			echo "Error: Directory $(CURRENT_DIR)/deployments/$(OPS_NETWORK) does not exist"; \
			exit 1; \
		fi; \
		CONTRACT_FILE=""; \
		contracts_list=$$(ls $(CURRENT_DIR)/deployments/$(OPS_NETWORK)/*.json | xargs -n1 basename | sed 's/\.json$$//'); \
		found=0; \
		for contract in $$contracts_list; do \
			contract_upper=$$(echo $$contract | sed 's/\([A-Z]\)/_\1/g' | sed 's/^_//' | tr 'a-z' 'A-Z'); \
			if [ "$(PARAMETER)" = "OPS_$${contract_upper}_ADDRESS" ]; then \
				CONTRACT_FILE="$${contract}.json"; \
				found=1; \
				break; \
			fi; \
		done; \
		if [ "$$found" -eq 0 ]; then \
			echo "Error: Unknown parameter $(PARAMETER)"; exit 1; \
		fi; \
		DEPLOYMENT_FILE="$(CURRENT_DIR)/deployments/$(OPS_NETWORK)/$$CONTRACT_FILE"; \
		if [ ! -f "$$DEPLOYMENT_FILE" ]; then \
			echo "Error: Deployment file $$DEPLOYMENT_FILE not found"; \
			exit 1; \
		fi; \
		ADDRESS=$$(cat "$$DEPLOYMENT_FILE" | grep '"address"' | head -1 | sed 's/.*"address": *"\([^"]*\)".*/\1/'); \
		echo "$$ADDRESS"; \
		}

get-outputs:
		@{ \
		$(MAKE) ID=OPS_NETWORK validate || exit 1; \
		if [ ! -d "$(CURRENT_DIR)/deployments/$(OPS_NETWORK)" ]; then \
			echo "Error: Directory $(CURRENT_DIR)/deployments/$(OPS_NETWORK) does not exist"; \
			exit 1; \
		fi; \
		result="{"; \
		first=1; \
		for file in $(CURRENT_DIR)/deployments/$(OPS_NETWORK)/*.json; do \
			filename=$$(basename $$file .json); \
			key="OPS_$$(echo $$filename | sed 's/\([A-Z]\)/_\1/g' | sed 's/^_//' | tr 'a-z' 'A-Z')_ADDRESS"; \
			if [ $$first -eq 1 ]; then \
				result="$$result\"$$key\": \"$$key\""; \
				first=0; \
			else \
				result="$$result, \"$$key\": \"$$key\""; \
			fi; \
		done; \
		result="$$result}"; \
		echo "$$result"; \
		}

validate:
		@{ \
			VALUE=$$(echo "$${!ID}" | tr -d '"'); \
			if [ -z "$${VALUE}" ]; then \
				echo "$${ID} is not set (Value: '$${VALUE}')!"; \
				exit 1; \
			fi; \
		}

help:
	@echo "Available targets:"
	@echo "  deploy-access-token         Deploy access token contracts"
	@echo "  deploy-settlement           Deploy settlement contract"
	@echo "  deploy-power-pod            Deploy power pod contract"
	@echo "  deploy-whitelist-registry   Deploy whitelist registry contract"
	@echo "  deploy-crosschain-whitelist Deploy crosschain whitelist contract"
	@echo "  deploy-resolver-metadata    Deploy resolver metadata contract"
	@echo "  validate-base               Validate base required environment variables"
	@echo "  validate-access-token       Validate access token deployment variables"
	@echo "  validate-settlement         Validate settlement deployment variables"
	@echo "  validate-power-pod          Validate power pod deployment variables"
	@echo "  validate-whitelist-registry Validate whitelist registry deployment variables"
	@echo "  validate-crosschain-whitelist Validate crosschain whitelist deployment variables"
	@echo "  validate-resolver-metadata  Validate resolver metadata deployment variables"
	@echo "  process-access-token-owner  Update access token owner constant"
	@echo "  process-access-token-salt   Update access token salt constant"
	@echo "  process-settlement-owner    Update settlement owner constant"
	@echo "  process-settlement-salt     Update settlement salt constant"
	@echo "  process-router-v6          Update router V6 address constant"
	@echo "  process-weth               Update WETH address constant"
	@echo "  process-st1inch            Update st1INCH address constant"
	@echo "  process-power-pod          Update PowerPod address constant"
	@echo "  process-dao                Update DAO address constant"
	@echo "  process-whitelist-registry Update WhitelistRegistry address constant"
	@echo "  process-create3-deployer    Update create3 deployer constant"
	@echo "  upsert-constant            Upsert constant value in JSON file"
	@echo "  deploy-skip-all            Mark all deploy files as skipped"
	@echo "  deploy-skip                Mark current deploy file as skipped"
	@echo "  deploy-noskip              Mark current deploy file as not skipped"
	@echo "  install                    Install utils and dependencies"
	@echo "  install-utils              Install required utilities"
	@echo "  install-dependencies       Install yarn dependencies"
	@echo "  clean                      Remove deployment files"
	@echo "  get PARAMETER=...          Get deployed contract address"
	@echo "  help                       Show this help message"


.PHONY: help deploy-access-token deploy-settlement deploy-power-pod deploy-whitelist-registry deploy-crosschain-whitelist deploy-resolver-metadata deploy-impl validate-base validate-access-token validate-settlement validate-power-pod validate-whitelist-registry validate-crosschain-whitelist validate-resolver-metadata process-access-token-owner process-access-token-salt process-access-token-address process-settlement-owner process-settlement-salt process-router-v6 process-weth process-st1inch process-power-pod process-dao process-whitelist-registry process-create3-deployer upsert-constant deploy-skip-all deploy-skip deploy-noskip install install-utils install-dependencies clean get get-outputs validate
