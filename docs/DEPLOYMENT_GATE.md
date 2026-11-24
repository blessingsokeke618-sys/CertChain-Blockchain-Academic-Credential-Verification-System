# Mainnet Deployment Confirmation Gate

To prevent accidental deployments to the Stellar Mainnet, all mainnet deployment scripts enforce an explicit confirmation gate (#114).

## Interactive Execution
When running `./scripts/deploy-mainnet.sh` interactively, the operator must type `CONFIRM_MAINNET_DEPLOY`.

## Automated / CI Execution
In automated or CI contexts, the environment variable `CONFIRM_MAINNET_DEPLOY=CONFIRM_MAINNET_DEPLOY` must be explicitly provided.
