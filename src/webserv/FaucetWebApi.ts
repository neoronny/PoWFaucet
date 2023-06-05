import { IncomingMessage } from "http";
import { faucetConfig } from "../config/FaucetConfig";
import { ServiceManager } from "../common/ServiceManager";
import { EthWalletManager } from "../services/EthWalletManager";
import { FaucetStatus, IFaucetStatus } from "../services/FaucetStatus";
import { FaucetHttpResponse } from "./FaucetHttpServer";
import { SessionManager } from "../session/SessionManager";
import { FaucetSession, FaucetSessionStatus, FaucetSessionStoreData } from "../session/FaucetSession";
import { ModuleHookAction, ModuleManager } from "../modules/ModuleManager";
import { IFaucetResultSharingConfig } from "../config/ConfigShared";
import { FaucetError } from "../common/FaucetError";
import { ClaimTx, EthClaimManager } from "../services/EthClaimManager";

export interface IFaucetApiUrl {
  path: string[];
  query: {[key: string]: string|boolean};
}

export interface IClientFaucetConfig {
  faucetTitle: string;
  faucetStatus: IFaucetStatus[];
  faucetStatusHash: string;
  faucetImage: string;
  faucetHtml: string;
  faucetCoinSymbol: string;
  faucetCoinType: string;
  faucetCoinContract: string;
  faucetCoinDecimals: number;
  minClaim: number;
  maxClaim: number;
  sessionTimeout: number;
  ethTxExplorerLink: string;
  time: number;
  resultSharing: IFaucetResultSharingConfig;
  modules: {
    [module: string]: any;
  },
}

const FAUCETSTATUS_CACHE_TIME = 10;

export class FaucetWebApi {
  private apiEndpoints: {[endpoint: string]: (req: IncomingMessage, url: IFaucetApiUrl, body: Buffer) => Promise<any>} = {};

  public async onApiRequest(req: IncomingMessage, body?: Buffer): Promise<any> {
    let apiUrl = this.parseApiUrl(req.url);
    if (!apiUrl || apiUrl.path.length === 0)
      return new FaucetHttpResponse(404, "Not Found");
    switch (apiUrl.path[0].toLowerCase()) {
      case "getMaxReward".toLowerCase():
        return this.onGetMaxReward();
      case "getFaucetConfig".toLowerCase():
        return this.onGetFaucetConfig(apiUrl.query['cliver'] as string, apiUrl.query['session'] as string);
      case "startSession".toLowerCase():
        return this.onStartSession(req, body);
      case "claimReward".toLowerCase():
        return this.onClaimReward(req, body);
      case "getClaimStatus".toLowerCase():
        return this.onGetClaimStatus(apiUrl.query['session'] as string);
      case "getSessionStatus".toLowerCase():
        return this.onGetSessionStatus(apiUrl.query['session'] as string);
      default:
        let handler: (req: IncomingMessage, url: IFaucetApiUrl, body: Buffer) => Promise<any>;
        if((handler = this.apiEndpoints[apiUrl.path[0].toLowerCase()]))
          return handler(req, apiUrl, body);
    }
    return new FaucetHttpResponse(404, "Not Found");
  }

  public registerApiEndpoint(endpoint: string, handler: (req: IncomingMessage, url: IFaucetApiUrl, body: Buffer) => Promise<any>) {
    this.apiEndpoints[endpoint.toLowerCase()] = handler;
  }

  public removeApiEndpoint(endpoint: string) {
    delete this.apiEndpoints[endpoint.toLowerCase()];
  }

  private parseApiUrl(url: string): IFaucetApiUrl {
    let urlMatch = /\/api\/([^?]+)(?:\?(.*))?/.exec(url);
    if(!urlMatch)
      return null;
    let urlRes: IFaucetApiUrl = {
      path: urlMatch[1] && urlMatch[1].length > 0 ? urlMatch[1].split("/") : [],
      query: {}
    };
    if(urlMatch[2] && urlMatch[2].length > 0) {
      urlMatch[2].split("&").forEach((query) => {
        let parts = query.split("=", 2);
        urlRes.query[parts[0]] = (parts.length == 1) ? true : parts[1];
      });
    }
    return urlRes;
  }

  private onGetMaxReward(): number {
    return faucetConfig.maxDropAmount;
  }

  public getFaucetHomeHtml(): string {
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    let faucetHtml = faucetConfig.faucetHomeHtml || "";
    faucetHtml = faucetHtml.replace(/{faucetWallet}/, () => {
      return ethWalletManager.getFaucetAddress();
    });
    return faucetHtml;
  }

  public onGetFaucetConfig(clientVersion: string, sessionId: string): IClientFaucetConfig {
    let faucetSession = sessionId ? ServiceManager.GetService(SessionManager).getSession(sessionId, [FaucetSessionStatus.RUNNING, FaucetSessionStatus.CLAIMABLE]) : null;
    let faucetStatus = ServiceManager.GetService(FaucetStatus).getFaucetStatus(clientVersion, faucetSession);
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    
    let moduleConfig = {};
    ServiceManager.GetService(ModuleManager).processActionHooks([], ModuleHookAction.ClientConfig, [moduleConfig, sessionId]);

    return {
      faucetTitle: faucetConfig.faucetTitle,
      faucetStatus: faucetStatus.status,
      faucetStatusHash: faucetStatus.hash,
      faucetImage: faucetConfig.faucetImage,
      faucetHtml: this.getFaucetHomeHtml(),
      faucetCoinSymbol: faucetConfig.faucetCoinSymbol,
      faucetCoinType: faucetConfig.faucetCoinType,
      faucetCoinContract: faucetConfig.faucetCoinContract,
      faucetCoinDecimals: ethWalletManager.getFaucetDecimals(),
      minClaim: faucetConfig.minDropAmount,
      maxClaim: faucetConfig.maxDropAmount,
      sessionTimeout: faucetConfig.sessionTimeout,
      ethTxExplorerLink: faucetConfig.ethTxExplorerLink,
      time: Math.floor((new Date()).getTime() / 1000),
      resultSharing: faucetConfig.resultSharing,
      modules: moduleConfig,
    };
  }

  public async onStartSession(req: IncomingMessage, body: Buffer): Promise<any> {
    if(req.method !== "POST")
      return new FaucetHttpResponse(405, "Method Not Allowed");
    
    let userInput = JSON.parse(body.toString("utf8"));
    let responseData: any = {};
    let session: FaucetSession;
    try {
      session = await ServiceManager.GetService(SessionManager).createSession(req.socket.remoteAddress, userInput, responseData);
      if(session.getSessionStatus() === FaucetSessionStatus.FAILED) {
        return {
          status: FaucetSessionStatus.FAILED,
          failedCode: session.getSessionData("failed.code"),
          failedReason: session.getSessionData("failed.reason"),
          balance: session.getDropAmount().toString(),
          target: session.getTargetAddr(),
        }
      }
    } catch(ex) {
      if(ex instanceof FaucetError) {
        responseData = ex;
        return {
          status: FaucetSessionStatus.FAILED,
          failedCode: ex.getCode(),
          failedReason: ex.message,
        }
      }
      else {
        console.error(ex, ex.stack);
        return {
          status: FaucetSessionStatus.FAILED,
          failedCode: "INTERNAL_ERROR",
          failedReason: ex.toString(),
        }
      }
    }

    Object.assign(responseData, {
      session: session.getSessionId(),
      status: session.getSessionStatus(),
      tasks: session.getBlockingTasks(),
      balance: session.getDropAmount().toString(),
      target: session.getTargetAddr(),
    });
    return responseData;
  }

  public async onClaimReward(req: IncomingMessage, body: Buffer): Promise<any> {
    if(req.method !== "POST")
      return new FaucetHttpResponse(405, "Method Not Allowed");
    
    let userInput = JSON.parse(body.toString("utf8"));
    let session: FaucetSession;
    if(!userInput || !userInput.session || !(session = ServiceManager.GetService(SessionManager).getSession(userInput.session, [FaucetSessionStatus.CLAIMABLE])))
      return new FaucetHttpResponse(404, "Session not found");
    
    try {
      await session.claimSession(userInput);
      if(session.getSessionStatus() === FaucetSessionStatus.FAILED) {
        return {
          status: FaucetSessionStatus.FAILED,
          failedCode: session.getSessionData("failed.code"),
          failedReason: session.getSessionData("failed.reason"),
          balance: session.getDropAmount().toString(),
          target: session.getTargetAddr(),
        }
      }
    } catch(ex) {
      if(ex instanceof FaucetError) {
        return {
          status: FaucetSessionStatus.FAILED,
          failedCode: ex.getCode(),
          failedReason: ex.message,
        }
      }
      else {
        console.error(ex, ex.stack);
        return {
          status: FaucetSessionStatus.FAILED,
          failedCode: "INTERNAL_ERROR",
          failedReason: ex.toString(),
        }
      }
    }

    let responseData = {};
    Object.assign(responseData, {
      session: session.getSessionId(),
      status: session.getSessionStatus(),
      balance: session.getDropAmount().toString(),
      target: session.getTargetAddr(),
    });
    return responseData;
  }

  public async onGetClaimStatus(sessionId: string): Promise<any> {
    let sessionData: FaucetSessionStoreData;
    if(!sessionId || !(sessionData = ServiceManager.GetService(SessionManager).getSessionData(sessionId))) {
      return {
        status: "unknown",
        error: "Session not found"
      };
    }
    if(!sessionData.data["claim.status"]) {
      return {
        status: "unknown",
        error: "Session not claiming"
      };
    }

    return {
      status: sessionData.data["claim.status"],
      queueIdx: sessionData.data["claim.queueIdx"],
      txhash: sessionData.data["claim.txhash"],
      txblock: sessionData.data["claim.txblock"],
      lastIdx: ServiceManager.GetService(EthClaimManager).getLastProcessedClaimIdx(),
    };
  }

  public async onGetSessionStatus(sessionId: string): Promise<any> {
    let sessionData: FaucetSessionStoreData;
    if(!sessionId || !(sessionData = ServiceManager.GetService(SessionManager).getSessionData(sessionId)))
      return new FaucetHttpResponse(404, "Session not found");
    
    return sessionData;
  }



}