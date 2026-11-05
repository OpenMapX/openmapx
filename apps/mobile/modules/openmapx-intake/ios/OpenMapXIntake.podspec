Pod::Spec.new do |s|
  s.name = 'OpenMapXIntake'
  s.version = '1.0.0'
  s.summary = 'Bounded local sharing and geographic document inbox'
  s.description = 'Host receiver and immutable App Group inbox. Share UI is built only in the extension target.'
  s.author = 'OpenMapX'
  s.homepage = 'https://github.com/OpenMapX/openmapx'
  s.license = 'AGPL-3.0-or-later'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.resource_bundles = { 'OpenMapXIntake_privacy' => ['PrivacyInfo.xcprivacy'] }
  s.swift_version = '5.9'
end
