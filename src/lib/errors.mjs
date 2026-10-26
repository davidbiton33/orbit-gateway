export class GatewayError extends Error {constructor(status,code,message,detail=null){super(message);this.name='GatewayError';this.status=status;this.code=code;this.detail=detail;}}
export const fail=(status,code,message,detail)=>{throw new GatewayError(status,code,message,detail)};
export function safeError(e){return {error:{message:String(e?.message||'Internal error').slice(0,350),type:e instanceof GatewayError?'invalid_request_error':'gateway_error',code:e?.code||'gateway_failure'}};}
