#import <React/RCTBridgeModule.h>

// Registers the Swift SafariView class with React Native. No bridging header needed.
@interface RCT_EXTERN_MODULE (SafariView, NSObject)

RCT_EXTERN_METHOD(open
                  : (NSString *)url resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

@end
