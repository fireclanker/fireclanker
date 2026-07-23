const deploymentName = process.env.FIRECLANKER_NAME

if (!deploymentName) {
  throw new Error("FIRECLANKER_NAME is required when loading the infrastructure stack")
}

export const DEPLOYMENT_NAME = deploymentName
export const TABLE_NAME = deploymentName
