#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Registers the Swift DeviceSecurity class with React Native. No bridging header needed.
@interface RCT_EXTERN_MODULE (DeviceSecurity, RCTEventEmitter)

RCT_EXTERN_METHOD(isScreenCaptured
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(isCompromised
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

@end
